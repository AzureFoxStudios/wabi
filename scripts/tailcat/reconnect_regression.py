#!/usr/bin/env python3
"""Opt-in, two-host Tailcat file-path regression. No production services required."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess as sp
import sys
import tempfile
import threading
import time

SIZE = 1024 * 1024
COUNT = 3
FIELDS = ('rx_direct_v4', 'rx_derp', 'tx_direct_v4', 'tx_derp')


def counters(text):
    rows = re.findall(r'FIELD counters: map\[([^\]]+)\]', text)
    if not rows:
        raise ValueError('Missing instrumented transport counters')
    value = {k: int(v) for k, v in re.findall(r'(\w+):(\d+)', rows[-1])}
    if any(k not in value for k in FIELDS):
        raise ValueError('Incomplete transport counters')
    return {k: value[k] for k in FIELDS}


def direct_payload(result):
    transfers = result.get('transfers', [])
    if len(transfers) != COUNT or any(
        t.get('bytes') != SIZE or t.get('sha256_matches') is not True or t.get('exit') != 0
        for t in transfers
    ):
        return False
    c = result.get('final_tunnel_byte_counters') or {}
    # A route probe/contact log alone never satisfies this assertion.
    return (all(isinstance(c.get(k), int) and c[k] >= 0 for k in FIELDS)
            and c['rx_direct_v4'] >= SIZE * COUNT and c['rx_derp'] == 0)


def verdict(first, reconnect):
    if not direct_payload(first):
        return 2, 'BASELINE_NOT_DIRECT: cannot assess the reconnect regression'
    if not direct_payload(reconnect):
        return 1, 'RECONNECT_REGRESSION: fresh direct payload passed; reconnect failed'
    return 0, 'PASS: fresh and same-identity reconnect payloads both direct'


def stop(p):
    if p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=10)
        except sp.TimeoutExpired:
            p.kill()
            p.wait(timeout=5)


def clean_env():
    env = dict(os.environ)
    # Do not inherit prior field impairments, active discovery, or route overrides.
    for k in list(env):
        if k.startswith(('TS_DEBUG_', 'TAILCAT_')):
            del env[k]
    return env


def serve(binary, key, root, lan_target=None):
    root = Path(root)
    payload = os.urandom(SIZE)
    other_lan = None
    if lan_target:
        host, port = lan_target.rsplit(':', 1)
        with socket.create_connection((host, int(port)), timeout=3):
            other_lan = {'host': host, 'port': int(port), 'reachable_from_server': True}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # A known-live unrelated service makes denial stronger than probing a closed port.
    unrelated = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Handler)
    threading.Thread(target=unrelated.serve_forever, daemon=True).start()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect(('192.0.2.1', 9))  # Route lookup only; no packet is sent.
        lan_address = route.getsockname()[0]
    env = clean_env()
    env.update(TAILCAT_ADDR_FILE=str(root / 'address'), XDG_CONFIG_HOME=str(root / 'config'))
    with (root / 'server.log').open('w') as log:
        p = sp.Popen([binary, 'serve', '--verbose', '--allow=' + key, str(server.server_port)],
                     env=env, stdout=log, stderr=log)
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
        try:
            deadline = time.monotonic() + 45
            while not (root / 'address').exists():
                if p.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Remote Tailcat listener failed to start')
                time.sleep(.2)
            print(json.dumps({'port': server.server_port,
                              'unrelated_port': unrelated.server_port, 'lan_address': lan_address, 'other_lan': other_lan,
                              'sha256': hashlib.sha256(payload).hexdigest(),
                              'address': (root / 'address').read_text().strip()}), flush=True)
            sys.stdin.read()  # Management channel EOF owns fixture lifetime.
        finally:
            stop(p)
            server.shutdown()
            unrelated.shutdown()


def socks_connect(proxy_port, host, port):
    """Test TCP admission itself, including non-HTTP SSH/SMB services."""
    with socket.create_connection(('127.0.0.1', proxy_port), timeout=8) as conn:
        def read(n):
            result = b''
            while len(result) < n:
                chunk = conn.recv(n - len(result))
                if not chunk:
                    raise ConnectionError('SOCKS closed before reply')
                result += chunk
            return result
        conn.sendall(b'\x05\x01\x00')
        if read(2) != b'\x05\x00':
            raise ValueError('SOCKS authentication negotiation failed')
        encoded = host.encode('ascii')
        conn.sendall(b'\x05\x01\x00\x03' + bytes([len(encoded)]) + encoded + port.to_bytes(2, 'big'))
        reply = read(4)
        if reply[0] != 5:
            raise ValueError('Invalid SOCKS reply')
        return reply[1]


def boundary_probes(proxy_port, meta):
    targets = [('allowed', 'server.tailcat', meta['port'])]
    targets += [(name, host, port) for name, host, port in [
        ('ssh', 'server.tailcat', 22), ('smb', 'server.tailcat', 445),
        ('unrelated-live', 'server.tailcat', meta['unrelated_port']),
        ('loopback-live', '127.0.0.1', meta['unrelated_port']),
        ('lan-interface-live', meta['lan_address'], meta['unrelated_port']),
        ('lan-allowed-port', meta['lan_address'], meta['port']),
    ]]
    if meta.get('other_lan'):
        target = meta['other_lan']
        if not target['reachable_from_server']:
            raise RuntimeError('Other LAN positive control unavailable')
        targets.append(('other-lan-live', target['host'], target['port']))
    results = []
    for name, host, port in targets:
        try:
            reply = socks_connect(proxy_port, host, port)
            row = {'target': name, 'socks_reply': reply, 'connected': reply == 0}
        except TimeoutError:
            row = {'target': name, 'connected': False, 'error': 'TimeoutError'}
        except (OSError, ValueError) as exc:
            raise RuntimeError('Boundary measurement failed for ' + name) from exc
        results.append(row)
        if name != 'allowed' and row['connected']:
            raise RuntimeError('SERVICE BOUNDARY ESCAPE: ' + name)
    if not results[0]['connected'] or socks_connect(proxy_port, 'server.tailcat', meta['port']) != 0:
        raise RuntimeError('Allowed service unavailable during boundary probes')
    return results


def session(binary, key, meta, root, name, *, force_relay=False, boundaries=False):
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    logpath = root / (name + '.log')
    env = clean_env()
    if force_relay:
        env.update(TS_DEBUG_ALWAYS_USE_DERP='true', TS_DEBUG_NEVER_DIRECT_UDP='true')
    with logpath.open('w') as log:
        p = sp.Popen([str(binary), '--verbose', '--key=' + str(key), 'socks',
                      '--listen=127.0.0.1:' + str(port), meta['address']],
                     env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 45
            while True:
                if p.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('SOCKS listener failed to start')
                # Confirm this process reports readiness, not merely another port owner.
                if 'SOCKS running at' in logpath.read_text():
                    with socket.create_connection(('127.0.0.1', port), timeout=1):
                        break
                time.sleep(.2)
            time.sleep(1)
            transfers = []
            for _ in range(COUNT):
                start = time.monotonic()
                q = sp.run(['curl', '--silent', '--show-error', '--max-time', '45',
                            '--noproxy', '', '--socks5-hostname', '127.0.0.1:' + str(port),
                            f'http://server.tailcat:{meta["port"]}/'], capture_output=True, timeout=50)
                transfers.append({'bytes': len(q.stdout), 'exit': q.returncode,
                                  'sha256_matches': hashlib.sha256(q.stdout).hexdigest() == meta['sha256'],
                                  'seconds': round(time.monotonic() - start, 3)})
                time.sleep(3)  # Includes a final counter sampling interval.
            result = {'transfers': transfers,
                      'final_tunnel_byte_counters': counters(logpath.read_text())}
            if boundaries:
                result['boundary_probes'] = boundary_probes(port, meta)
            return result
        finally:
            stop(p)


def run(args):
    root = Path(args.output).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(root, 0o700)
    result = {'server': args.ssh, 'sessions': {}, 'cleanup': False}
    remote = None
    control = None
    code = 2
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.ssh]
    def remote_run(command):
        return sp.check_output(ssh + [command], text=True, timeout=20).strip()
    try:
        server_binary = Path(args.server_binary).resolve()
        client_binary = Path(args.client_binary).resolve()
        result['binary_sha256'] = {k: hashlib.sha256(p.read_bytes()).hexdigest()
                                   for k, p in [('server', server_binary), ('client', client_binary)]}
        key = root / 'client.private.json'
        pub = sp.check_output([str(client_binary), 'genkey', '--client', '--key=' + str(key)],
                              env=clean_env(), text=True, timeout=15).strip()
        if not re.fullmatch(r'nodekey:[0-9a-f]{64}', pub):
            raise ValueError('Unexpected generated public key')
        remote = remote_run('mkdir -p "$HOME/.local/share"; mktemp -d "$HOME/.local/share/wabi-tailcat-regression.XXXXXXXX"')
        if not re.fullmatch(r'/[\w./-]+/wabi-tailcat-regression\.[A-Za-z0-9]+', remote):
            raise ValueError('Unexpected remote temporary path')
        for src, name in [(server_binary, 'tailcat'), (Path(__file__).resolve(), 'test.py')]:
            sp.run(['scp', '-q', '-o', 'BatchMode=yes', str(src), args.ssh + ':' + remote + '/' + name],
                   check=True, timeout=60)
        remote_run('chmod 700 ' + shlex.quote(remote + '/tailcat'))
        serve_args = ['python3', remote + '/test.py', '--serve', remote + '/tailcat', pub, remote]
        if getattr(args, 'lan_target', None):
            serve_args.append(args.lan_target)
        command = shlex.join(serve_args)
        with (root / 'ssh.log').open('w') as log:
            control = sp.Popen(ssh + [command], stdin=sp.PIPE, stdout=sp.PIPE, stderr=log, text=True)
            # Remote fixture has a 45-second startup deadline; cap SSH reads too.
            import select
            if not select.select([control.stdout], [], [], 60)[0]:
                raise RuntimeError('Remote fixture readiness timed out')
            meta = json.loads(control.stdout.readline())
            result['other_lan_control_verified'] = bool(meta.get('other_lan', {}).get('reachable_from_server')) if meta.get('other_lan') else False
            names = ['fresh', 'reconnect'] + ['reconnect-' + str(i) for i in range(2, getattr(args, 'cycles', 1) + 1)]
            for name in names:
                result['sessions'][name] = session(client_binary, key, meta, root, name,
                                                   boundaries=getattr(args, 'boundaries', False) and name == 'fresh')
            code, result['verdict'] = verdict(result['sessions']['fresh'], result['sessions']['reconnect'])
            for name in names[2:]:
                cycle_code, cycle_verdict = verdict(result['sessions']['fresh'], result['sessions'][name])
                if cycle_code:
                    code, result['verdict'] = cycle_code, cycle_verdict + ' (' + name + ')'
            if getattr(args, 'fallback', False):
                relay = session(client_binary, key, meta, root, 'forced-relay', force_relay=True)
                result['sessions']['forced-relay'] = relay
                c = relay['final_tunnel_byte_counters']
                result['fallback_passed'] = (len(relay['transfers']) == COUNT and
                    all(t['sha256_matches'] and t['bytes'] == SIZE and t['exit'] == 0 for t in relay['transfers']) and
                    c['rx_direct_v4'] == 0 and c['rx_derp'] >= SIZE * COUNT)
                if not result['fallback_passed']:
                    code, result['verdict'] = 1, 'DERP_FALLBACK_REGRESSION'
            sp.run(['scp', '-q', '-o', 'BatchMode=yes', args.ssh + ':' + remote + '/server.log',
                    str(root / 'server.log')], check=True, timeout=20)
    except Exception as exc:
        code = 1 if 'SERVICE BOUNDARY ESCAPE' in str(exc) else 2
        result['error'] = str(exc)
        result['verdict'] = 'INCOMPLETE: ' + str(exc)
    finally:
        if control:
            control.stdin.close()
            try:
                control.wait(timeout=15)
            except sp.TimeoutExpired:
                stop(control)
        try:
            if remote and re.fullmatch(r'/[\w./-]+/wabi-tailcat-regression\.[A-Za-z0-9]+', remote):
                remote_run('rm -rf -- ' + shlex.quote(remote))
            result['cleanup'] = True
        except Exception as exc:
            result['cleanup_error'] = str(exc)
            result['verdict'] = 'INCOMPLETE: fixture cleanup failed'
            code = 2
        (root / 'client.private.json').unlink(missing_ok=True)
        (root / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    print(result.get('verdict', result.get('error', 'Test incomplete')))
    print('Private evidence:', root / 'results.json')
    return code


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--serve':
        serve(*sys.argv[2:])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--ssh', required=True, help='Authorized server user@host on a different network')
        parser.add_argument('--server-binary', required=True, help='Unmodified pinned Tailcat binary')
        parser.add_argument('--client-binary', required=True, help='Counter-only diagnostic Tailcat binary')
        parser.add_argument('--output', required=True, help='New private evidence directory')
        parser.add_argument('--cycles', type=int, choices=range(1, 11), default=1, help='Saved-identity reconnect cycles (1-10)')
        parser.add_argument('--fallback', action='store_true', help='Also verify process-only forced DERP fallback')
        parser.add_argument('--lan-target', help='Authorized other LAN host:port; requires a successful server-side TCP control')
        parser.add_argument('--boundaries', action='store_true', help='Probe forbidden ports and fixed-target boundary from admitted client')
        sys.exit(run(parser.parse_args()))
