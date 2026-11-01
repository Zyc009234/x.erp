#!/usr/bin/env python3
"""x.erp 匿名使用统计 + 用户留言服务（部署在官网服务器，只用 Python 标准库，IP 库为 ip2region 的数据文件）

- POST /xerp/api/ping              x.erp 每天报一次 {id: 32 位随机十六进制, v: 版本号, plat: 系统类型}
- POST /xerp/api/feedback          用户在 x.erp 里留言 {token, v, plat, nick, contact, text, allowPublic}
- POST /xerp/api/feedback/mine     x.erp 取本机留言和作者回复 {token}（token 是每台 x.erp 自己随机生成的，库里只存它的哈希）
- GET  /xerp/api/feedback/public   官网留言墙：作者选择公开、且用户同意公开的留言（不含联系方式）
- GET  /xerp/api/admin             统计后台（HTTP Basic 认证，用户名 admin）
- GET  /xerp/api/admin/feedback    留言后台：回复、公开 / 取消公开、删除

IP 不落盘：收到上报时用离线 IP 库（ip2region_v4.xdb）查出所在城市，再把 IP 做带密钥的 HMAC 哈希，
只保存「城市」和「哈希」——哈希用来把同一个 IP（同一个公司 / 家庭网络）的多台设备合并成一个计数。

数据库、密码、哈希密钥放在 STATE_DIR（systemd 的 StateDirectory，默认 /var/lib/xerp-stats）：
  stats.db   sqlite
  admin.pw   pbkdf2 哈希；设置密码：echo -n '新密码' | python3 stats.py setpw
  ip.key     IP 哈希密钥（首次启动自动生成，删掉后旧哈希就对不上了）
"""
import base64, hashlib, hmac, html, ipaddress, json, os, re, secrets, sqlite3, struct, sys, threading, time, urllib.parse
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
    c.execute('CREATE TABLE IF NOT EXISTS feedback (fid INTEGER PRIMARY KEY AUTOINCREMENT, tok TEXT, created TEXT, v TEXT, plat TEXT, nick TEXT, contact TEXT, '
              'text TEXT, city TEXT, allow_pub INTEGER DEFAULT 0, pub INTEGER DEFAULT 0, reply TEXT, replied TEXT)')
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
def limited(ip, mx=None):
    now = time.time()
    with lock:
        if len(hits) > 10000: hits.clear()
        t = [x for x in hits.get(ip, []) if now - x < 3600]
        t.append(now); hits[ip] = t
        return len(t) > (mx or HIT_MAX)


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
<body><main><h1>x.erp 使用统计</h1><div class="m"><a href="/xerp/api/admin/feedback" style="color:var(--p)">用户留言（待回复 {fb_todo()} 条）→</a> · 大数字按 IP 去重（同一个网络下的多台设备算 1 个），小字是设备数 · {today.isoformat()}</div>
<div class="g">{kpi('累计 IP', total)}{kpi('今天活跃', act[1])}{kpi('近 7 天活跃', act[7])}{kpi('近 30 天活跃', act[30])}{kpi('近 30 天新增', new30)}</div>
<div class="c"><h2>每日活跃 IP<small>近 30 天，鼠标停在柱子上看设备数</small></h2><div class="bars">{bars}</div></div>
<div class="c"><h2>城市分布<small>近 30 天；使用天次 = 设备每天上报一次的累计次数</small></h2>{tbl(['城市', 'IP', '设备', '使用天次'], cities)}</div>
<div class="two"><div class="c"><h2>版本分布<small>近 30 天活跃</small></h2>{tbl(['版本', 'IP', '设备'], [('v' + v, a, b) for v, a, b in vers])}</div>
<div class="c"><h2>系统分布<small>近 30 天活跃</small></h2>{tbl(['系统', 'IP', '设备'], [(PLATS.get(p, '其他'), a, b) for p, a, b in plats])}</div></div></main></body></html>'''


# ---------- 用户留言 ----------
now_str = lambda: time.strftime('%Y-%m-%d %H:%M')
tok_hash = lambda t: hashlib.sha256(('xerp-fb:' + t).encode()).hexdigest()
TOKEN_RE = r'[0-9a-f]{32}'


def fb_add(b, ip):
    t, text = b.get('token'), str(b.get('text') or '').strip()
    if not (isinstance(t, str) and re.fullmatch(TOKEN_RE, t)): return None
    if not 1 <= len(text) <= 2000: return None
    v = b.get('v') if isinstance(b.get('v'), str) and re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,4}', b.get('v')) else ''
    p = b.get('plat') if b.get('plat') in PLATS else 'other'
    nick, contact = str(b.get('nick') or '').strip()[:30], str(b.get('contact') or '').strip()[:100]
    with lock, db() as c:
        cur = c.execute('INSERT INTO feedback (tok, created, v, plat, nick, contact, text, city, allow_pub) VALUES (?,?,?,?,?,?,?,?,?)',
                        (tok_hash(t), now_str(), v, p, nick, contact, text, city_of(ip), 1 if b.get('allowPublic') else 0))
        return cur.lastrowid


def fb_mine(b):
    t = b.get('token')
    if not (isinstance(t, str) and re.fullmatch(TOKEN_RE, t)): return None
    with db() as c:
        rows = c.execute('SELECT fid, created, text, reply, replied, pub FROM feedback WHERE tok = ? ORDER BY fid', (tok_hash(t),)).fetchall()
    return [dict(fid=r[0], created=r[1], text=r[2], reply=r[3] or '', replied=r[4] or '', public=bool(r[5])) for r in rows]


def fb_public():
    with db() as c:
        rows = c.execute('SELECT nick, city, created, text, reply FROM feedback WHERE pub = 1 AND allow_pub = 1 ORDER BY fid DESC LIMIT 100').fetchall()
    return [dict(nick=r[0] or '匿名用户', date=r[2][:10], text=r[3], reply=r[4] or '') for r in rows]  # 不公开城市


# 后台表单的防跨站提交令牌：由后台密码哈希派生，改密码后旧页面的表单自动失效
def csrf_token():
    with open(PW_FILE) as f: return hmac.new(f.read().strip().encode(), b'xerp-admin-csrf', hashlib.sha256).hexdigest()[:32]


def fb_admin_act(form):
    g = lambda k: (form.get(k) or [''])[0]
    if not hmac.compare_digest(g('csrf'), csrf_token()): return False
    try: fid = int(g('fid'))
    except ValueError: return False
    act = g('act')
    with lock, db() as c:
        if act == 'reply':
            r = g('reply').strip()[:2000]
            c.execute('UPDATE feedback SET reply = ?, replied = ? WHERE fid = ?', (r or None, now_str() if r else None, fid))
        elif act in ('pub', 'unpub'): c.execute('UPDATE feedback SET pub = ? WHERE fid = ? AND allow_pub = 1', (1 if act == 'pub' else 0, fid))
        elif act == 'del': c.execute('DELETE FROM feedback WHERE fid = ?', (fid,))
        else: return False
    return True


def fb_todo():
    with db() as c: return c.execute('SELECT COUNT(*) FROM feedback WHERE reply IS NULL').fetchone()[0]


FB_CSS = '''<style>:root{--bg:#f6f7fb;--card:#fff;--fg:#1e293b;--m:#64748b;--p:#4f46e5;--bd:#e2e8f0;--ok:#059669;--warn:#d97706;--bad:#dc2626}@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--fg:#e2e8f0;--m:#94a3b8;--p:#818cf8;--bd:#334155;--ok:#34d399;--warn:#fbbf24;--bad:#f87171}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:860px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}a{color:var(--p)}.m{color:var(--m)}
.c{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin:12px 0}.top{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--m)}.txt{white-space:pre-wrap;word-break:break-word;margin:8px 0}
.tag{font-size:12px;padding:0 8px;border-radius:99px;border:1px solid currentColor}.ok{color:var(--ok)}.warn{color:var(--warn)}textarea{width:100%;box-sizing:border-box;min-height:64px;border:1px solid var(--bd);border-radius:8px;padding:8px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center}button{border:1px solid var(--bd);background:var(--card);color:var(--fg);border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer}button.p{background:var(--p);border-color:var(--p);color:#fff}button.d{color:var(--bad)}button:disabled{opacity:.45;cursor:not-allowed}form{display:inline}</style>'''


def fb_admin_page():
    with db() as c:
        rows = c.execute('SELECT fid, created, v, plat, nick, contact, text, city, allow_pub, pub, reply, replied FROM feedback ORDER BY (reply IS NULL) DESC, fid DESC').fetchall()
    e, tok = (lambda s: html.escape(str(s or ''))), csrf_token()
    hidden = lambda fid, act: f'<input type="hidden" name="csrf" value="{tok}"><input type="hidden" name="fid" value="{fid}"><input type="hidden" name="act" value="{act}">'
    cards = ''
    for fid, created, v, plat, nick, contact, text, city, allow, pub, reply, replied in rows:
        state = '<span class="tag ok">已回复</span>' if reply else '<span class="tag warn">待回复</span>'
        pubtag = ('<span class="tag ok">官网已公开</span>' if pub else '<span class="tag">同意公开</span>') if allow else '<span class="tag">不同意公开</span>'
        pub_btn = f'<button {"" if allow else "disabled title=用户没有同意公开"}>{"取消公开" if pub else "公开到官网"}</button>'
        cards += f'''<div class="c" id="f{fid}"><div class="top"><b>#{fid}</b><span>{e(created)}</span><span>{e(nick) or '匿名'}</span><span>{e(contact) or '未留联系方式'}</span><span>{e(city)}</span><span>v{e(v)} · {e(PLATS.get(plat, '其他'))}</span>{state}{pubtag}</div>
<div class="txt">{e(text)}</div>
<form method="post">{hidden(fid, 'reply')}<textarea name="reply" placeholder="回复内容（用户在 x.erp 的「问题反馈」里能看到）">{e(reply)}</textarea><div class="row"><button class="p">{'更新回复' if reply else '回复'}</button>{f'<span class="m">回复于 {e(replied)}</span>' if replied else ''}</div></form>
<div class="row"><form method="post">{hidden(fid, 'unpub' if pub else 'pub')}{pub_btn}</form>
<form method="post" onsubmit="return confirm('删除这条留言？用户那边也会看不到。')">{hidden(fid, 'del')}<button class="d">删除</button></form></div></div>'''
    todo = sum(1 for r in rows if not r[10])
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>x.erp 用户留言</title>{FB_CSS}</head>
<body><main><h1>用户留言</h1><div class="m">共 {len(rows)} 条，待回复 {todo} 条 · <a href="/xerp/api/admin">← 使用统计</a> · 公开的留言显示在 <a href="/xerp/#feedback" target="_blank">官网 /xerp/</a>（不含联系方式）</div>
{cards or '<div class="c m">还没有留言</div>'}</main></body></html>'''


class H(BaseHTTPRequestHandler):
    server_version = 'xerp-stats'
    def log_message(self, *a): pass  # 不记访问日志（里面有 IP）
    def out(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        b = body.encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def authed(self):
        if check_auth(self.headers.get('Authorization')): return True
        time.sleep(1)  # 拖慢猜密码
        self.out(401, '需要登录', 'text/plain; charset=utf-8', {'WWW-Authenticate': 'Basic realm="x.erp stats", charset="UTF-8"'})
        return False
    def body(self, limit):
        n = int(self.headers.get('Content-Length') or 0)
        return None if n > limit else self.rfile.read(n)
    def do_POST(self):
        path = self.path.split('?')[0]
        ip = (self.headers.get('X-Forwarded-For') or self.client_address[0]).split(',')[0].strip()  # Caddy 写入的真实来源
        bad = lambda: self.out(400, '{"error":"bad request"}')
        if path == '/xerp/api/admin/feedback':
            if not self.authed(): return
            raw = self.body(20000)
            if raw is None or not fb_admin_act(urllib.parse.parse_qs(raw.decode('utf-8', 'replace'))): return self.out(400, '操作无效，请刷新页面再试', 'text/plain; charset=utf-8')
            return self.out(303, '', 'text/plain', {'Location': '/xerp/api/admin/feedback'})
        if path not in ('/xerp/api/ping', '/xerp/api/feedback', '/xerp/api/feedback/mine'): return self.out(404, '{"error":"not found"}')
        if limited(ip) or path == '/xerp/api/feedback' and limited('fb:' + ip, 10): return self.out(429, '{"error":"too many"}')
        raw = self.body(8192 if path == '/xerp/api/feedback' else 1024)
        if raw is None: return self.out(413, '{"error":"too large"}')
        try: b = json.loads(raw or b'{}')
        except Exception: return bad()
        if not isinstance(b, dict): return bad()
        if path == '/xerp/api/ping': return self.out(200, '{"ok":true}') if record(b, ip) else bad()
        if path == '/xerp/api/feedback':
            fid = fb_add(b, ip)
            return self.out(200, json.dumps({'fid': fid})) if fid else bad()
        rows = fb_mine(b)
        return bad() if rows is None else self.out(200, json.dumps(rows, ensure_ascii=False))
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/xerp/api/feedback/public': return self.out(200, json.dumps(fb_public(), ensure_ascii=False))
        if path not in ('/xerp/api/admin', '/xerp/api/admin/feedback'): return self.out(404, '{"error":"not found"}')
        if not self.authed(): return
        self.out(200, report() if path == '/xerp/api/admin' else fb_admin_page(), 'text/html; charset=utf-8')

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
