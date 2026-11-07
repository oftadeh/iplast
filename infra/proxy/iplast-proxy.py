#!/usr/bin/env python3
"""Outbound proxy for servers that reach Telegram/OpenAI/GitHub only through a VPN (e.g. inside Iran).

Runs on the host as root. The same xray config runs twice: on the host (127.0.0.1:10809, for git, image builds
and deploy notices) and as the `proxy` container of the compose project (proxy:10809, for the api and bot
containers; host firewalls often block containers from reaching host ports).

  iplast-proxy.py apply      take a new source from inbox/request.txt (set from the admin panel), or re-use the saved one
  iplast-proxy.py check      health check; when the active server fails, pick another working one from the saved source

A source is a subscription URL (V2Ray format, base64 list of links) or one or more vless:// vmess:// trojan:// links.
Each candidate is tested on a spare port against api.telegram.org before it becomes active.
Status for the admin panel goes to inbox/status.json (no secrets in it).
"""
import base64, json, os, subprocess, sys, time, urllib.parse as U, urllib.request

HOME = '/opt/iplast-proxy'
INBOX = f'{HOME}/inbox'
XRAY = f'{HOME}/xray'
CONFIG = f'{HOME}/config.json'
CONFIG_DOCKER = f'{HOME}/config-docker.json'
SOURCE = f'{HOME}/source.txt'
STATUS = f'{INBOX}/status.json'
PORT, TEST_PORT = 10809, 10899
TEST_URL = 'https://api.telegram.org'


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def b64(s):
    s = s.strip().replace('-', '+').replace('_', '/')
    return base64.b64decode(s + '=' * (-len(s) % 4)).decode('utf-8', 'replace')


def read_status():
    try:
        return json.load(open(STATUS))
    except Exception:
        return {}


def write_status(**kw):
    st = read_status()
    st.update(kw)
    os.makedirs(INBOX, exist_ok=True)
    tmp = STATUS + '.tmp'
    json.dump(st, open(tmp, 'w'), ensure_ascii=False, indent=1)
    os.replace(tmp, STATUS)


def fetch(url):
    """Subscription servers are usually reachable directly; fall back to the current proxy."""
    errors = []
    for proxy in (None, f'http://127.0.0.1:{PORT}'):
        try:
            handlers = [urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {})]
            opener = urllib.request.build_opener(*handlers)
            req = urllib.request.Request(url, headers={'User-Agent': 'v2rayN/6.0'})
            return opener.open(req, timeout=25).read().decode('utf-8', 'replace')
        except Exception as e:  # noqa: BLE001
            errors.append(str(e)[:80])
    raise RuntimeError('دریافت اشتراک ناموفق بود: ' + ' / '.join(errors))


def links_from(source):
    source = source.strip()
    if source.startswith(('http://', 'https://')):
        body = fetch(source).strip()
        text = body if '://' in body[:20] else b64(body)
    else:
        text = source
    return [l.strip() for l in text.split() if l.strip().startswith(('vless://', 'vmess://', 'trojan://'))]


def stream(net, sec, q):
    s = {'network': net or 'tcp', 'security': sec or 'none'}
    sni = q.get('sni') or q.get('host') or ''
    if sec == 'tls':
        t = {'serverName': sni, 'fingerprint': q.get('fp') or 'chrome'}
        if q.get('alpn'):
            t['alpn'] = q['alpn'].split(',')
        if q.get('allowInsecure') in ('1', 'true'):
            t['allowInsecure'] = True
        s['tlsSettings'] = t
    elif sec == 'reality':
        s['realitySettings'] = {'serverName': sni, 'fingerprint': q.get('fp') or 'chrome', 'publicKey': q.get('pbk', ''),
                                'shortId': q.get('sid', ''), 'spiderX': q.get('spx', '')}
    if net == 'ws':
        s['wsSettings'] = {'path': q.get('path') or '/', 'headers': {'Host': q.get('host', '')} if q.get('host') else {}}
    elif net == 'grpc':
        s['grpcSettings'] = {'serviceName': q.get('serviceName', '')}
    elif net in ('httpupgrade',):
        s['httpupgradeSettings'] = {'path': q.get('path') or '/', 'host': q.get('host', '')}
    elif net in ('xhttp', 'splithttp'):
        s['xhttpSettings'] = {'path': q.get('path') or '/', 'host': q.get('host', '')}
    elif net == 'tcp' and q.get('headerType') == 'http':
        s['tcpSettings'] = {'header': {'type': 'http', 'request': {'path': [q.get('path') or '/'], 'headers': {'Host': [q.get('host', '')]}}}}
    return s


def outbound(link):
    """Returns (name, xray outbound) for one share link."""
    if link.startswith('vmess://'):
        v = json.loads(b64(link[8:]))
        q = {k: str(v.get(k2, '')) for k, k2 in (('sni', 'sni'), ('host', 'host'), ('path', 'path'), ('fp', 'fp'), ('alpn', 'alpn'), ('headerType', 'type'), ('serviceName', 'path'))}
        if not q['sni']:
            q['sni'] = q['host']
        ob = {'protocol': 'vmess', 'settings': {'vnext': [{'address': v['add'], 'port': int(v['port']),
              'users': [{'id': v['id'], 'alterId': int(v.get('aid') or 0), 'security': v.get('scy') or 'auto'}]}]},
              'streamSettings': stream(v.get('net'), 'tls' if v.get('tls') == 'tls' else 'none', q)}
        return v.get('ps') or v['add'], ob
    u = U.urlparse(link)
    q = dict(U.parse_qsl(u.query))
    name = U.unquote(u.fragment) or u.hostname
    user = U.unquote(u.username or '')
    if u.scheme == 'vless':
        ob = {'protocol': 'vless', 'settings': {'vnext': [{'address': u.hostname, 'port': u.port or 443,
              'users': [{'id': user, 'encryption': q.get('encryption') or 'none', 'flow': q.get('flow', '')}]}]},
              'streamSettings': stream(q.get('type'), q.get('security'), q)}
    else:  # trojan
        ob = {'protocol': 'trojan', 'settings': {'servers': [{'address': u.hostname, 'port': u.port or 443, 'password': user}]},
              'streamSettings': stream(q.get('type'), q.get('security') or 'tls', q)}
    return name, ob


def config(ob, listen, port):
    return {'log': {'loglevel': 'warning'},
            'inbounds': [{'listen': a, 'port': port, 'protocol': 'http'} for a in listen],
            'outbounds': [dict(ob, tag='out'), {'protocol': 'freedom', 'tag': 'direct'}]}


def works(port):
    r = subprocess.run(['curl', '-sS', '-o', '/dev/null', '-m', '12', '-x', f'http://127.0.0.1:{port}', TEST_URL],
                       capture_output=True)
    return r.returncode == 0


def test(ob):
    path = f'{HOME}/test.json'
    json.dump(config(ob, ('127.0.0.1',), TEST_PORT), open(path, 'w'))
    p = subprocess.Popen([XRAY, 'run', '-config', path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.5)
        return p.poll() is None and works(TEST_PORT)
    finally:
        p.terminate()
        try:
            p.wait(5)
        except Exception:  # noqa: BLE001
            p.kill()


def install(ob):
    os.makedirs(HOME, exist_ok=True)
    for path, listen in ((CONFIG, ('127.0.0.1',)), (CONFIG_DOCKER, ('0.0.0.0',))):
        json.dump(config(ob, listen, PORT), open(path, 'w'), indent=1)
        os.chmod(path, 0o644)  # read by the proxy container
    subprocess.run(['systemctl', 'restart', 'iplast-proxy'], check=False)
    subprocess.run(['docker', 'restart', 'iplast-proxy-1'], check=False, capture_output=True)
    time.sleep(2)


def migrate():
    """Older installs: host config also listened on 172.17.0.1 and there was no container config."""
    if os.path.exists(CONFIG) and not os.path.exists(CONFIG_DOCKER):
        ob = next(o for o in json.load(open(CONFIG))['outbounds'] if o.get('protocol') != 'freedom')
        install(ob)


def choose(source, prefer=None):
    links = links_from(source)
    if not links:
        raise RuntimeError('هیچ کانفیگ vless / vmess / trojan در این اشتراک پیدا نشد')
    cands = []
    for l in links:
        try:
            cands.append(outbound(l))
        except Exception:  # noqa: BLE001
            pass
    if prefer:  # try the other servers first when the active one just failed
        cands.sort(key=lambda c: c[0] == prefer)
    for name, ob in cands:
        if test(ob):
            install(ob)
            return name, len(links)
    raise RuntimeError(f'هیچ‌کدام از {len(links)} کانفیگ به تلگرام وصل نشد (ممکن است اشتراک تمام شده باشد)')


def apply():
    req = f'{INBOX}/request.txt'
    source = None
    if os.path.exists(req):
        source = open(req).read().strip()
        os.remove(req)
    elif os.path.exists(SOURCE):
        source = open(SOURCE).read().strip()
    if not source:
        return
    write_status(state='working', message='در حال آزمایش کانفیگ‌ها…', updatedAt=now())
    try:
        name, count = choose(source)
    except Exception as e:  # noqa: BLE001
        write_status(state='error', message=str(e)[:300], updatedAt=now())
        return
    open(SOURCE, 'w').write(source)
    os.chmod(SOURCE, 0o600)
    write_status(state='ok', server=name, count=count, message='پراکسی فعال است', updatedAt=now(), checkedAt=now(),
                 sourceKind='subscription' if source.startswith('http') else 'links')


def check():
    if os.path.exists(f'{INBOX}/request.txt'):
        return apply()
    if works(PORT):
        write_status(state='ok', checkedAt=now())
        return
    st = read_status()
    if not os.path.exists(SOURCE):
        write_status(state='error', message='پراکسی کار نمی‌کند و اشتراکی ذخیره نشده است', checkedAt=now())
        return
    try:
        name, count = choose(open(SOURCE).read().strip(), prefer=st.get('server'))
        write_status(state='ok', server=name, count=count, message='سرور قبلی قطع بود؛ سرور دیگری از اشتراک فعال شد', updatedAt=now(), checkedAt=now())
    except Exception as e:  # noqa: BLE001
        write_status(state='error', message=str(e)[:300], checkedAt=now())


if __name__ == '__main__':
    os.makedirs(INBOX, exist_ok=True)
    {'apply': apply, 'check': check, 'migrate': migrate}.get(sys.argv[1] if len(sys.argv) > 1 else 'check', check)()
