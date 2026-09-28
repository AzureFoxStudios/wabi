#!/usr/bin/env python3
"""Build an isolated, pinned Tailcat diagnostic client. Never replace shipped binaries."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess as sp
import tarfile
import urllib.request

REVISION = 'ce6fedcabc220bab3b94d470ab330219111eeae8'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--go', default='go', help='Go 1.27.0 executable')
    p.add_argument('--output', required=True, help='New build directory')
    p.add_argument('--trace-discovery', action='store_true', help='Log endpoint exchange, reused peers, UDP discovery sends/receives and crypto rejection; private diagnostic only')
    args = p.parse_args()
    go = shutil.which(args.go)
    if not go or 'go1.27.0 ' not in sp.check_output([go, 'version'], text=True):
        p.error('Use the pinned Go 1.27.0 toolchain')
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    archive = root / 'source.tar.gz'
    with urllib.request.urlopen(f'https://api.github.com/repos/tailscale/tailcat/tarball/{REVISION}', timeout=60) as response:
        archive.write_bytes(response.read())
    extracted = root / 'extracted'
    extracted.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(extracted, filter='data')
    source = next(extracted.iterdir())
    env = dict(__import__('os').environ, GOTOOLCHAIN='local')
    dependency = json.loads(sp.check_output([go, 'mod', 'download', '-json', 'tailscale.com'],
                                           cwd=source, env=env, text=True))
    transport = root / 'tailscale-source'
    shutil.copytree(dependency['Dir'], transport)
    transport.chmod(transport.stat().st_mode | 0o700)
    for item in transport.rglob('*'):
        item.chmod(item.stat().st_mode | (0o700 if item.is_dir() else 0o200))
    with (source / 'go.mod').open('a') as f:
        f.write('\nreplace tailscale.com => ' + str(transport) + '\n')
    (transport / 'wgengine/magicsock/field_stats.go').write_text('''package magicsock
func (c *Conn) FieldStats() map[string]int64 {
 return map[string]int64{"rx_direct_v4":c.metrics.inboundBytesIPv4Total.Value(), "rx_derp":c.metrics.inboundBytesDERPTotal.Value(), "tx_direct_v4":c.metrics.outboundBytesIPv4Total.Value(), "tx_derp":c.metrics.outboundBytesDERPTotal.Value()}
}
''')
    (source / 'field_stats.go').write_text('''package tailcat
func (c *Client) FieldStats() map[string]int64 { return c.lb.sys.MagicSock.Get().FieldStats() }
''')
    cli = source / 'cmd/tailcat/tailcat.go'
    text = cli.read_text()
    anchor = '\t\tlogf("got ping: %+v", pi)\n\t}\n\n\tvar clientsMu'
    if text.count(anchor) != 1:
        raise RuntimeError('Pinned CLI contract changed: refusing to guess instrumentation location')
    text = text.replace(anchor, '''\t\tlogf("got ping: %+v", pi)
        go func() { for { logf("FIELD counters: %v", cl.FieldStats()); time.Sleep(time.Second) } }()
\t}

\tvar clientsMu''')
    cli.write_text(text)
    if args.trace_discovery:
        patches = Path(__file__).resolve().parent
        for target, patch in [(source, 'discovery-trace-tailcat.patch'),
                              (transport, 'discovery-trace-magicsock.patch')]:
            sp.run(['git', 'apply', '--check', str(patches / patch)], cwd=target, check=True)
            sp.run(['git', 'apply', '--whitespace=nowarn', str(patches / patch)], cwd=target, check=True)
    binary = root / 'tailcat-counters'
    sp.run([go, 'build', '-buildvcs=false', '-o', str(binary), './cmd/tailcat'],
           cwd=source, env=env, check=True)
    manifest = {'revision': REVISION, 'go': sp.check_output([go, 'version'], text=True).strip(),
                'tailscale_dependency': dependency['Version'], 'tailscale_sum': dependency.get('Sum'),
                'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                'instrumentation': 'read-only existing magicsock counters; no discovery/reconnect changes',
                'build_features': 'default; differs from stripped release binary',
                'discovery_trace': args.trace_discovery}
    (root / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(binary)


if __name__ == '__main__':
    main()
