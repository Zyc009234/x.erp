#!/usr/bin/env python3
"""x.erp 匿名使用统计服务（部署在官网服务器，只用 Python 标准库 + 随附的 ip2region 查询代码）

- POST /xerp/api/ping   x.erp 每天报一次 {id: 32 位随机十六进制, v: 版本号, plat: 系统类型}
- GET  /xerp/api/admin  统计后台（HTTP Basic 认证，用户名 admin）

IP 不落盘：收到上报时用离线 IP 库（ip2region_v4.xdb）查出所在城市，再把 IP 做带密钥的 HMAC 哈希，
只保存「城市」和「哈希」——哈希用来把同一个 IP（同一个公司 / 家庭网络）的多台设备合并成一个计数。

数据库、密码、哈希密钥放在 STATE_DIR（systemd 的 StateDirectory，默认 /var/lib/xerp-stats）：
  stats.db   sqlite
  admin.pw   pbkdf2 哈希；设置密码：echo -n '新密码' | python3 stats.py setpw
  ip.key     IP 哈希密钥（首次启动自动生成，删掉后旧哈希就对不上了）
"""
import base64, hashlib, hmac, html, ipaddress, json, os, re, secrets, sqlite3, struct, sys, threading, time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

STATE = os.environ.get('STATE_DIRECTORY') or os.environ.get('XERP_STATS_DIR') or '/var/lib/xerp-stats'
PORT = int(os.environ.get('XERP_STATS_PORT', '8092'))
XDB = os.environ.get('XERP_STATS_XDB') or os.path.join(HERE, 'ip2region_v4.xdb')
DB_FILE, PW_FILE, KEY_FILE = (os.path.join(STATE, f) for f in ('stats.db', 'admin.pw', 'ip.key'))
PLATS = {'win32': 'Windows', 'linux': '飞牛 / Linux', 'darwin': 'macOS'}
lock = threading.Lock()


def db():
    c = sqlite3.connect(DB_FILE)
    c.execute('CREATE TABLE IF NOT EXISTS installs (id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, version TEXT, plat TEXT)')
    c.execute('CREATE TABLE IF NOT EXISTS days (day TEXT, id TEXT, PRIMARY KEY (day, id))')
    for t in ('installs', 'days'):  # 旧库补列：iph = IP 哈希，city = 城市
        have = {r[1] for r in c.execute(f'PRAGMA table_info({t})')}
        for col in ('iph', 'city'):
            if col not in have: c.execute(f'ALTER TABLE {t} ADD COLUMN {col} TEXT')
    return c


# ---------- IP → 城市（离线库）、IP → 哈希 ----------
class Geo:
    """读 ip2region 的 IPv4 xdb 文件（https://github.com/lionsoul2014/ip2region 的 data/ip2region_v4.xdb）
    结构：256 字节头 → 256×256 向量索引（每格 8 字节：段索引起止指针）→ 段索引（每条 14 字节：起始 IP、结束 IP（小端 uint32）、数据长度 uint16、数据指针 uint32）→ 地区文本"""
    def __init__(self, path):
        self.f, self.lock = open(path, 'rb'), threading.Lock()
        self.f.seek(256); self.vi = self.f.read(256 * 256 * 8)
    def search(self, ip):
        b = ipaddress.IPv4Address(ip).packed
        s, e = struct.unpack_from('<II', self.vi, (b[0] * 256 + b[1]) * 8)
        if not s or not e: return ''
        n, lo, hi = int.from_bytes(b, 'big'), 0, (e - s) // 14
        with self.lock:
            while lo <= hi:
                mid = (lo + hi) // 2
                self.f.seek(s + mid * 14); sip, eip, dl, dp = struct.unpack('<IIHI', self.f.read(14))
                if n < sip: hi = mid - 1
                elif n > eip: lo = mid + 1
                else: self.f.seek(dp); return self.f.read(dl).decode('utf-8')
        return ''

geo = None
def city_of(ip):
    global geo
    try:
        a = ipaddress.ip_address(ip)
        if a.version == 6: return 'IPv6（未识别）'
        if a.is_private or a.is_loopback: return '内网'
        if geo is None: geo = Geo(XDB)
        f = geo.search(ip).split('|')  # 国家|省份|城市|运营商|代码
        f = [x if x not in ('0', 'Reserved') else '' for x in f] + [''] * 5
        if f[0] == '中国': return ' '.join(x for x in (f[1], f[2] if f[2] != f[1] else '') if x) or '中国'
        return f[0] or '未知'
    except Exception:
        return '未知'

ip_key = None
def ip_hash(ip):
    global ip_key
    if ip_key is None:
        if not os.path.exists(KEY_FILE):
            with open(KEY_FILE, 'w') as f: f.write(secrets.token_hex(32))
            os.chmod(KEY_FILE, 0o600)
        ip_key = bytes.fromhex(open(KEY_FILE).read().strip())
    return hmac.new(ip_key, ip.encode(), hashlib.sha256).hexdigest()[:20]


# 简单限流：每个来源每小时最多 30 次（只在内存里，不落盘）
hits, HIT_MAX = {}, 30
def limited(ip):
    now = time.time()
    with lock:
        if len(hits) > 10000: hits.clear()
        t = [x for x in hits.get(ip, []) if now - x < 3600]
        t.append(now); hits[ip] = t
        return len(t) > HIT_MAX


def record(body, ip):
    i, v, p = body.get('id'), body.get('v'), body.get('plat')
    if not (isinstance(i, str) and re.fullmatch(r'[0-9a-f]{32}', i)): return False
    if not (isinstance(v, str) and re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,4}', v)): return False
    p = p if p in PLATS else 'other'
    d, h, city = date.today().isoformat(), ip_hash(ip), city_of(ip)
    with lock, db() as c:
        c.execute('INSERT INTO installs (id, first_seen, last_seen, version, plat, iph, city) VALUES (?,?,?,?,?,?,?) '
                  'ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version, plat=excluded.plat, iph=excluded.iph, city=excluded.city',
                  (i, d, d, v, p, h, city))
        c.execute('INSERT INTO days (day, id, iph, city) VALUES (?,?,?,?) ON CONFLICT(day, id) DO UPDATE SET iph=excluded.iph, city=excluded.city', (d, i, h, city))
    return True


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    return salt + '$' + hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), 200000).hex()


def check_auth(header):
    m = re.fullmatch(r'Basic (.+)', header or '')
    if not m or not os.path.exists(PW_FILE): return False
    try: user, pw = base64.b64decode(m.group(1)).decode().split(':', 1)
    except Exception: return False
    saved = open(PW_FILE).read().strip()
    return user == 'admin' and hmac.compare_digest(hash_pw(pw, saved.split('$')[0]), saved)


# 「人数」按 IP 去重：同一个 IP 下的多台设备算一个；升级前没有 IP 哈希的老数据按设备算
WHO = "COALESCE(iph, 'id:' || id)"

def report():
    today = date.today()
    ago = lambda n: (today - timedelta(days=n)).isoformat()
    with db() as c:
        one = lambda sql, *a: c.execute(sql, a).fetchone()
        q = lambda sql, *a: c.execute(sql, a).fetchall()
        total = one(f'SELECT COUNT(DISTINCT {WHO}), COUNT(*) FROM installs')
        act = {n: one(f'SELECT COUNT(DISTINCT {WHO}), COUNT(*) FROM installs WHERE last_seen >= ?', ago(n - 1)) for n in (1, 7, 30)}
        new30 = one(f'SELECT COUNT(DISTINCT {WHO}), COUNT(*) FROM installs WHERE first_seen >= ?', ago(29))
        daily = {d: (u, n) for d, u, n in q(f'SELECT day, COUNT(DISTINCT {WHO}), COUNT(*) FROM days WHERE day >= ? GROUP BY day', ago(29))}
        cities = q(f"SELECT COALESCE(city, '未知（升级统计前的数据）'), COUNT(DISTINCT {WHO}), COUNT(DISTINCT id), COUNT(*) FROM days WHERE day >= ? GROUP BY 1 ORDER BY 2 DESC, 4 DESC", ago(29))
        vers = q(f'SELECT version, COUNT(DISTINCT {WHO}), COUNT(*) FROM installs WHERE last_seen >= ? GROUP BY version', ago(29))
        plats = q(f'SELECT plat, COUNT(DISTINCT {WHO}), COUNT(*) FROM installs WHERE last_seen >= ? GROUP BY plat ORDER BY 2 DESC', ago(29))
    vers.sort(key=lambda r: [int(x) for x in r[0].split('.')], reverse=True)
    days = [ago(n) for n in range(29, -1, -1)]
    top = max([daily.get(d, (0, 0))[0] for d in days] + [1])
    bars = ''.join(f'<div class="b" title="{d}：{daily.get(d, (0, 0))[0]} 个 IP，{daily.get(d, (0, 0))[1]} 台设备"><i style="height:{daily.get(d, (0, 0))[0] / top * 100:.1f}%"></i><span>{d[8:]}</span></div>' for d in days)
    e = lambda s: html.escape(str(s))
    tbl = lambda head, rows: f'<table><tr>{"".join(f"<th>{h}</th>" for h in head)}</tr>' + (''.join('<tr>' + ''.join(f'<td>{e(x)}</td>' for x in r) + '</tr>' for r in rows) or f'<tr><td colspan="{len(head)}" class="m">暂无</td></tr>') + '</table>'
    kpi = lambda t, ab: f'<div class="k"><span>{t}</span><b>{ab[0]}</b><small>{ab[1]} 台设备</small></div>'
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>x.erp 使用统计</title>
<style>:root{{--bg:#f6f7fb;--card:#fff;--fg:#1e293b;--m:#64748b;--p:#4f46e5;--bd:#e2e8f0}}@media(prefers-color-scheme:dark){{:root{{--bg:#0f172a;--card:#1e293b;--fg:#e2e8f0;--m:#94a3b8;--p:#818cf8;--bd:#334155}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}}main{{max-width:960px;margin:0 auto;padding:24px 16px}}h1{{font-size:20px;margin:0 0 4px}}.m{{color:var(--m)}}
.g{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}}.k,.c{{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px}}.k span,.k small{{display:block;color:var(--m);font-size:12px}}.k b{{font-size:26px}}
.c{{margin-bottom:12px;overflow-x:auto}}.c h2{{font-size:15px;margin:0 0 10px}}.c h2 small{{font-weight:400;color:var(--m);margin-left:6px}}.bars{{display:flex;gap:3px;height:150px;align-items:flex-end}}.b{{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}}.b i{{display:block;width:100%;background:var(--p);border-radius:3px 3px 0 0;min-height:1px}}.b span{{font-size:10px;color:var(--m)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}@media(max-width:640px){{.two{{grid-template-columns:1fr}}.b span{{display:none}}}}table{{width:100%;border-collapse:collapse}}th{{text-align:left;color:var(--m);font-weight:500;font-size:12px}}th,td{{padding:6px 8px 6px 0;border-bottom:1px solid var(--bd);white-space:nowrap}}td+td,th+th{{text-align:right}}</style></head>
<body><main><h1>x.erp 使用统计</h1><div class="m">大数字按 IP 去重（同一个网络下的多台设备算 1 个），小字是设备数 · {today.isoformat()}</div>
<div class="g">{kpi('累计 IP', total)}{kpi('今天活跃', act[1])}{kpi('近 7 天活跃', act[7])}{kpi('近 30 天活跃', act[30])}{kpi('近 30 天新增', new30)}</div>
<div class="c"><h2>每日活跃 IP<small>近 30 天，鼠标停在柱子上看设备数</small></h2><div class="bars">{bars}</div></div>
<div class="c"><h2>城市分布<small>近 30 天；使用天次 = 设备每天上报一次的累计次数</small></h2>{tbl(['城市', 'IP', '设备', '使用天次'], cities)}</div>
<div class="two"><div class="c"><h2>版本分布<small>近 30 天活跃</small></h2>{tbl(['版本', 'IP', '设备'], [('v' + v, a, b) for v, a, b in vers])}</div>
<div class="c"><h2>系统分布<small>近 30 天活跃</small></h2>{tbl(['系统', 'IP', '设备'], [(PLATS.get(p, '其他'), a, b) for p, a, b in plats])}</div></div></main></body></html>'''


class H(BaseHTTPRequestHandler):
    server_version = 'xerp-stats'
    def log_message(self, *a): pass  # 不记访问日志（里面有 IP）
    def out(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        b = body.encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        if self.path != '/xerp/api/ping': return self.out(404, '{"error":"not found"}')
        ip = (self.headers.get('X-Forwarded-For') or self.client_address[0]).split(',')[0].strip()  # Caddy 写入的真实来源
        if limited(ip): return self.out(429, '{"error":"too many"}')
        n = int(self.headers.get('Content-Length') or 0)
        if n > 1024: return self.out(413, '{"error":"too large"}')
        try: ok = record(json.loads(self.rfile.read(n) or b'{}'), ip)
        except Exception: ok = False
        self.out(200 if ok else 400, '{"ok":true}' if ok else '{"error":"bad request"}')
    def do_GET(self):
        if self.path.split('?')[0] != '/xerp/api/admin': return self.out(404, '{"error":"not found"}')
        if not check_auth(self.headers.get('Authorization')):
            time.sleep(1)  # 拖慢猜密码
            return self.out(401, '需要登录', 'text/plain; charset=utf-8', {'WWW-Authenticate': 'Basic realm="x.erp stats", charset="UTF-8"'})
        self.out(200, report(), 'text/html; charset=utf-8')


if __name__ == '__main__':
    os.makedirs(STATE, exist_ok=True)
    if sys.argv[1:] == ['setpw']:
        pw = sys.stdin.read().strip()
        if len(pw) < 8: sys.exit('密码至少 8 位')
        with open(PW_FILE, 'w') as f: f.write(hash_pw(pw))
        os.chmod(PW_FILE, 0o600); print('后台密码已设置')
        sys.exit()
    if len(sys.argv) == 3 and sys.argv[1] == 'city':  # 自检：python3 stats.py city 1.2.3.4
        print(city_of(sys.argv[2])); sys.exit()
    db().close()
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
