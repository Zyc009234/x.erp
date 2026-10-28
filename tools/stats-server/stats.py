#!/usr/bin/env python3
"""x.erp 匿名使用统计服务（部署在官网服务器，只用 Python 标准库）

- POST /xerp/api/ping   x.erp 每天报一次 {id: 32 位随机十六进制, v: 版本号, plat: 系统类型}；不记录 IP
- GET  /xerp/api/admin  统计后台（HTTP Basic 认证，用户名 admin）

数据库与密码放在 STATE_DIR（systemd 的 StateDirectory，默认 /var/lib/xerp-stats）：
  stats.db   sqlite
  admin.pw   pbkdf2 哈希；设置密码：echo -n '新密码' | python3 stats.py setpw
"""
import base64, hashlib, hmac, html, json, os, re, secrets, sqlite3, sys, threading, time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = os.environ.get('STATE_DIRECTORY') or os.environ.get('XERP_STATS_DIR') or '/var/lib/xerp-stats'
PORT = int(os.environ.get('XERP_STATS_PORT', '8092'))
DB_FILE, PW_FILE = os.path.join(STATE, 'stats.db'), os.path.join(STATE, 'admin.pw')
PLATS = {'win32': 'Windows', 'linux': '飞牛 / Linux', 'darwin': 'macOS'}
lock = threading.Lock()


def db():
    c = sqlite3.connect(DB_FILE)
    c.execute('CREATE TABLE IF NOT EXISTS installs (id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, version TEXT, plat TEXT)')
    c.execute('CREATE TABLE IF NOT EXISTS days (day TEXT, id TEXT, PRIMARY KEY (day, id))')
    return c


# 简单限流：每个来源 IP 每小时最多 30 次（IP 只在内存里，不落盘）
hits, HIT_MAX = {}, 30
def limited(ip):
    now = time.time()
    with lock:
        if len(hits) > 10000: hits.clear()
        t = [x for x in hits.get(ip, []) if now - x < 3600]
        t.append(now); hits[ip] = t
        return len(t) > HIT_MAX


def record(body):
    i, v, p = body.get('id'), body.get('v'), body.get('plat')
    if not (isinstance(i, str) and re.fullmatch(r'[0-9a-f]{32}', i)): return False
    if not (isinstance(v, str) and re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,4}', v)): return False
    p = p if p in PLATS else 'other'
    d = date.today().isoformat()
    with lock, db() as c:
        c.execute('INSERT INTO installs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version, plat=excluded.plat', (i, d, d, v, p))
        c.execute('INSERT OR IGNORE INTO days VALUES (?,?)', (d, i))
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


def report():
    today = date.today()
    ago = lambda n: (today - timedelta(days=n)).isoformat()
    with db() as c:
        q = lambda sql, *a: c.execute(sql, a).fetchall()
        total = q('SELECT COUNT(*) FROM installs')[0][0]
        act = {n: q('SELECT COUNT(*) FROM installs WHERE last_seen >= ?', ago(n - 1))[0][0] for n in (1, 7, 30)}
        new30 = q('SELECT COUNT(*) FROM installs WHERE first_seen >= ?', ago(29))[0][0]
        daily = dict(q('SELECT day, COUNT(*) FROM days WHERE day >= ? GROUP BY day', ago(29)))
        newd = dict(q('SELECT first_seen, COUNT(*) FROM installs WHERE first_seen >= ? GROUP BY first_seen', ago(29)))
        vers = q('SELECT version, COUNT(*) FROM installs WHERE last_seen >= ? GROUP BY version', ago(29))
        plats = q('SELECT plat, COUNT(*) FROM installs WHERE last_seen >= ? GROUP BY plat ORDER BY 2 DESC', ago(29))
    vers.sort(key=lambda r: [int(x) for x in r[0].split('.')], reverse=True)
    days = [ago(n) for n in range(29, -1, -1)]
    top = max([daily.get(d, 0) for d in days] + [1])
    bars = ''.join(f'<div class="b" title="{d}：活跃 {daily.get(d, 0)}，新装 {newd.get(d, 0)}"><i style="height:{daily.get(d, 0) / top * 100:.1f}%"></i><span>{d[8:]}</span></div>' for d in days)
    rows = lambda data, label=lambda k: k: ''.join(f'<tr><td>{html.escape(label(k))}</td><td>{n}</td></tr>' for k, n in data) or '<tr><td colspan="2" class="m">暂无</td></tr>'
    kpi = lambda t, n, s='': f'<div class="k"><span>{t}</span><b>{n}</b><small>{s}</small></div>'
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>x.erp 使用统计</title>
<style>:root{{--bg:#f6f7fb;--card:#fff;--fg:#1e293b;--m:#64748b;--p:#4f46e5;--bd:#e2e8f0}}@media(prefers-color-scheme:dark){{:root{{--bg:#0f172a;--card:#1e293b;--fg:#e2e8f0;--m:#94a3b8;--p:#818cf8;--bd:#334155}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}}main{{max-width:960px;margin:0 auto;padding:24px 16px}}h1{{font-size:20px;margin:0 0 4px}}.m{{color:var(--m)}}
.g{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}}.k,.c{{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px}}.k span,.k small{{display:block;color:var(--m);font-size:12px}}.k b{{font-size:26px}}
.c{{margin-bottom:12px}}.c h2{{font-size:15px;margin:0 0 10px}}.bars{{display:flex;gap:3px;height:150px;align-items:flex-end}}.b{{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}}.b i{{display:block;width:100%;background:var(--p);border-radius:3px 3px 0 0;min-height:1px}}.b span{{font-size:10px;color:var(--m)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}@media(max-width:640px){{.two{{grid-template-columns:1fr}}.b span{{display:none}}}}table{{width:100%;border-collapse:collapse}}td{{padding:6px 0;border-bottom:1px solid var(--bd)}}td:last-child{{text-align:right;font-weight:600}}</style></head>
<body><main><h1>x.erp 使用统计</h1><div class="m">按匿名安装编号计数（每台设备一个，重装或换数据目录会算新的）· {today.isoformat()}</div>
<div class="g">{kpi('累计装机', total)}{kpi('今天活跃', act[1])}{kpi('近 7 天活跃', act[7])}{kpi('近 30 天活跃', act[30])}{kpi('近 30 天新装', new30)}</div>
<div class="c"><h2>每日活跃（近 30 天）</h2><div class="bars">{bars}</div></div>
<div class="two"><div class="c"><h2>版本分布（近 30 天活跃）</h2><table>{rows(vers, lambda v: 'v' + v)}</table></div>
<div class="c"><h2>系统分布（近 30 天活跃）</h2><table>{rows(plats, lambda p: PLATS.get(p, '其他'))}</table></div></div></main></body></html>'''


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
        ip = (self.headers.get('X-Forwarded-For') or self.client_address[0]).split(',')[0].strip()
        if limited(ip): return self.out(429, '{"error":"too many"}')
        n = int(self.headers.get('Content-Length') or 0)
        if n > 1024: return self.out(413, '{"error":"too large"}')
        try: ok = record(json.loads(self.rfile.read(n) or b'{}'))
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
    db().close()
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
