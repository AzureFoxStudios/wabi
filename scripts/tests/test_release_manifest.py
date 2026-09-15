"""Artifact identity validation with disposable, deliberately mismatched fixtures."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/write-release-manifest.mjs'
REVISION = 'a' * 40

class ReleaseManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wabi-manifest-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.frontend = self.root / 'frontend'
        self.frontend.mkdir()
        (self.frontend / 'index.html').write_text('<!doctype html><p>fixture</p>')
        (self.frontend / 'wabi-client-build.json').write_text(json.dumps(dict(schemaVersion=1, component='wabi-frontend', version='1.0.0', sourceRevision=REVISION)))
        self.binary = self.root / 'wabi-server'
        self.identity = dict(schemaVersion=1, component='wabi-server', version='0.1.0', sourceRevision=REVISION, profile='release', targetOs='linux', targetArch='x86_64')
        self.write_binary()
        self.output = self.root / 'manifest.json'

    def write_binary(self):
        self.binary.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps(self.identity) + "'\n")
        self.binary.chmod(0o700)

    def generate(self):
        return subprocess.run(['node', str(SCRIPT), '--binary', str(self.binary), '--frontend', str(self.frontend), '--output', str(self.output)], env={'PATH': os.environ['PATH'], 'WABI_SOURCE_REVISION': REVISION}, capture_output=True, text=True)

    def test_matching_release_records_exact_artifact_bytes(self):
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(self.output.read_text())
        self.assertEqual(manifest['server']['sha256'], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertEqual(manifest['client']['fileCount'], 2)
        self.assertEqual(manifest['sourceRevision'], REVISION)
        self.assertNotIn(str(self.root), self.output.read_text())

    def test_wrong_server_revision_and_debug_binary_are_rejected(self):
        for field, value in [('sourceRevision', 'b' * 40), ('profile', 'debug')]:
            original = self.identity[field]
            self.identity[field] = value
            self.write_binary()
            self.assertNotEqual(self.generate().returncode, 0)
            self.assertFalse(self.output.exists())
            self.identity[field] = original

    def test_mismatched_frontend_revision_is_rejected(self):
        path = self.frontend / 'wabi-client-build.json'
        identity = json.loads(path.read_text())
        identity['sourceRevision'] = 'b' * 40
        path.write_text(json.dumps(identity))
        self.assertNotEqual(self.generate().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_artifact_symlinks_are_not_followed(self):
        (self.root / 'outside').write_text('keep outside artifact')
        (self.frontend / 'escape').symlink_to(self.root / 'outside')
        self.assertNotEqual(self.generate().returncode, 0)
        self.assertFalse(self.output.exists())

if __name__ == '__main__':
    unittest.main()
