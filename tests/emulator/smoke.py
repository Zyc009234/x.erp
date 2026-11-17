from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET

EVIDENCE = Path('evidence')
PACKAGE = 'com.xerp.client'
FIXTURE = json.loads(Path('tests/emulator/fixture.json').read_text())
DOCUMENT = FIXTURE['check']['no']


def adb(*args, capture=True):
    return subprocess.run(['adb', *args], check=True, capture_output=capture,
                          timeout=30).stdout


def shell(*args):
    return adb('shell', *map(str, args)).decode(errors='replace')


def screenshot(filename):
    png = adb('exec-out', 'screencap', '-p')
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    (EVIDENCE / filename).write_bytes(png)


def hierarchy():
    shell('uiautomator', 'dump', '/sdcard/xerp-ui.xml')
    xml = adb('exec-out', 'cat', '/sdcard/xerp-ui.xml')
    (EVIDENCE / 'last-ui.xml').write_bytes(xml)
    return list(ET.fromstring(xml).iter('node'))


def label(node):
    return node.get('text', '').strip() or node.get('content-desc', '').strip()


def wait_node(predicate, seconds=20):
    end = time.monotonic() + seconds
    labels = []
    while time.monotonic() < end:
        try:
            nodes = hierarchy()
        except (subprocess.SubprocessError, ET.ParseError):
            time.sleep(0.4)
            continue
        labels = [label(n) for n in nodes if label(n)]
        for node in nodes:
            if predicate(node):
                return node
        time.sleep(0.35)
    raise AssertionError(f'UI element not found. Visible labels: {labels}')


def exact(text):
    normalized = ''.join(text.split())
    return lambda node: ''.join(label(node).split()) == normalized


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds', '')))
    assert x2 > x1 and y2 > y1, node.attrib
    shell('input', 'tap', (x1 + x2) // 2, (y1 + y2) // 2)


def click(text, seconds=20):
    tap(wait_node(exact(text), seconds))


def api(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request('http://127.0.0.1:18686' + path, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    return json.load(urllib.request.urlopen(req, timeout=10))


def server_count():
    token = api('/api/login', {'username': 'admin', 'password': 'admin123'})['token']
    data = api('/api/data', token=token)['data']
    doc = next(doc for doc in data['checkDocs'] if doc['id'] == FIXTURE['check']['id'])
    return doc['lines'][0]['counted']


def run():
    shell('settings', 'put', 'global', 'hide_error_dialogs', '1')
    shell('wm', 'size', '720x1600')
    shell('wm', 'density', '300')
    shell('wm', 'dismiss-keyguard')
    time.sleep(3)
    apk = next(Path('emulator-apk').rglob('*.apk'))
    print(adb('install', '-g', str(apk)).decode().strip())
    print('Android API:', shell('getprop', 'ro.build.version.sdk').strip())
    print('Forwarding the isolated test service over ADB')
    adb('reverse', 'tcp:18686', 'tcp:18686')
    assert api('/api/ping')['app'] == 'XERP'
    shell('am', 'start', '-W', '-S', '-n', PACKAGE + '/.MainActivity')
    tap(wait_node(lambda node: node.get('class') == 'android.widget.EditText'))
    shell('input', 'text', '127.0.0.1:18686')
    shell('input', 'keyevent', '4')
    time.sleep(1)
    click('连接')
    print('Submitted the server address')
    try:
        click('登 录', 12)
    except AssertionError:
        click('连接', 6)
        click('登 录', 25)
    print('Submitted the test login')
    stock = exact('库存管理')
    try:
        tap(wait_node(stock, 5))
    except AssertionError:
        click('折叠菜单', 8)
        tap(wait_node(stock, 10))
    click('盘点单')
    click(DOCUMENT)
    assert server_count() is None
    print('Opened inventory document', DOCUMENT)
    click('连续扫码')
    time.sleep(8)
    screenshot('scan-preview.png')
    print('Opened the virtual camera')
    wait_node(lambda n: '已累加 1 ' in label(n), 40)
    wait_node(exact('1'), 8)
    screenshot('01-single-scan.png')
    time.sleep(5)
    wait_node(exact('1'), 6)
    screenshot('02-same-code-held.png')
    print('Single-item code remained at 1')
    assert server_count() is None
    wait_node(lambda n: '已累加 12 ' in label(n), 45)
    wait_node(exact('13'), 8)
    screenshot('03-box-scan-total-13.png')
    print('Case code added 12 for a total of 13')
    click('完成扫码')
    wait_node(lambda n: DOCUMENT in label(n), 15)
    wait_node(exact('13'), 12)
    assert server_count() is None
    screenshot('04-original-document-before-save.png')
    click('保存')
    for _ in range(15):
        if server_count() == 13:
            break
        time.sleep(0.5)
    assert server_count() == 13
    wait_node(lambda n: DOCUMENT in label(n), 15)
    wait_node(exact('13'), 12)
    screenshot('05-original-document-after-save.png')
    result = {'document': DOCUMENT, 'single': 1, 'same_code_after_5_seconds': 1,
              'box_increment': 12, 'draft_total': 13, 'before_save': None,
              'after_save': 13, 'checked_at': datetime.now().isoformat()}
    print(json.dumps(result))
    (EVIDENCE / 'result.json').write_text(json.dumps(result, indent=2))


try:
    run()
except Exception:
    try:
        screenshot('failure-screen.png')
        (EVIDENCE / 'logcat.txt').write_bytes(adb('logcat', '-d', '-t', '500'))
    except Exception:
        pass
    raise
