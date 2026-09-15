"""Exercise candidate packaging with checked fixture bytes; no GitHub writes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'package-release-candidate.mjs'
REVISION = 'a' * 40

class ReleasePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = self.root / 'artifacts'
        server = self.inputs / 'wabi-server'
        server.mkdir(parents=True)
        (server / 'wabi-server').write_bytes(b'fixture server bytes')
        self.manifest = {'schemaVersion': 1, 'sourceRevision': REVISION,
            'server': {'component': 'wabi-server', 'profile': 'release', 'sourceRevision': REVISION,
                       'file': 'wabi-server', 'sha256': hashlib.sha256(b'fixture server bytes').hexdigest(),
                       'bytes': len(b'fixture server bytes'), 'targetOs': 'linux', 'targetArch': 'x86_64'},
            'client': {'sourceRevision': REVISION}}
        (server / 'wabi-release-manifest.json').write_text(json.dumps(self.manifest))
        for platform, name in [('linux', 'Wabi.deb'), ('windows', 'Wabi setup.exe'), ('macos', 'Wabi.dmg')]:
            directory = self.inputs / f'wabi-desktop-{platform}' / 'nested'
            directory.mkdir(parents=True)
            (directory / name).write_bytes(platform.encode())
        self.output = self.root / 'dist'

    def run_package(self):
        return subprocess.run(['node', str(SCRIPT), '--artifacts', str(self.inputs), '--output', str(self.output)],
                              env={**os.environ, 'WABI_SOURCE_REVISION': REVISION}, capture_output=True, text=True)

    def test_all_assets_have_basename_checksums_and_executable_server(self):
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = (self.output / 'SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(lines), 4)
        for line in lines:
            digest, name = line.split('  ', 1)
            self.assertEqual(Path(name).name, name)
            self.assertEqual(digest, hashlib.sha256((self.output / name).read_bytes()).hexdigest())
        with tarfile.open(self.output / 'wabi-server-linux-x86_64.tar.gz') as archive:
            self.assertEqual(archive.getnames(), ['wabi-server', 'wabi-release-manifest.json'])
            self.assertEqual(archive.getmember('wabi-server').mode & 0o777, 0o755)
            self.assertEqual(archive.extractfile('wabi-server').read(), b'fixture server bytes')
        self.assertNotEqual(self.run_package().returncode, 0, 'existing output must not be overwritten')

    def test_mismatched_binary_is_rejected(self):
        (self.inputs / 'wabi-server' / 'wabi-server').write_bytes(b'changed bytes')
        self.assertNotEqual(self.run_package().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_duplicate_basenames_are_rejected_before_packaging(self):
        (self.inputs / 'wabi-desktop-macos' / 'nested' / 'Wabi.deb').write_bytes(b'collision')
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Duplicate installer basename', result.stderr)
        self.assertFalse(self.output.exists())

    def test_mismatched_revision_is_rejected(self):
        self.manifest['client']['sourceRevision'] = 'b' * 40
        (self.inputs / 'wabi-server' / 'wabi-release-manifest.json').write_text(json.dumps(self.manifest))
        self.assertNotEqual(self.run_package().returncode, 0)
        self.assertFalse(self.output.exists())

if __name__ == '__main__':
    unittest.main()
