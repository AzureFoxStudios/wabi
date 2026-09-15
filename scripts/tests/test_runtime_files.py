import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'check-runtime-files.py'
spec = importlib.util.spec_from_file_location('runtime_guard', SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class RuntimeFilesTest(unittest.TestCase):
    def test_operator_state_and_nested_environment_files(self):
        for name in ['data/root_key', 'data/chat.db', 'uploads/a.png', 'nested/data/wabidb/00001.seg',
                     'jwt_secret', 'root_key', '.env', '.env.production', 'relay/relay.env',
                     'relay/relay.env.local', 'server_owner.json']:
            with self.subTest(name=name):
                self.assertTrue(guard.is_runtime_file(name))

    def test_source_and_documented_templates(self):
        for name in ['.env.example', 'relay-node/relay-node.env.example',
                     'core/crates/wabi-server/data/blacklist.txt', 'docs/data-model.md',
                     'frontend/src/lib/database.ts']:
            with self.subTest(name=name):
                self.assertFalse(guard.is_runtime_file(name))

    def test_indexed_runtime_file_rejected_without_reading_or_deleting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            subprocess.run(['git', 'init', '-q', directory], check=True)
            secret = root / '.env'
            secret.write_text('PRIVATE_CANARY_NOT_FOR_OUTPUT')
            subprocess.run(['git', 'add', '.env'], cwd=root, check=True)
            result = subprocess.run(['python3', str(SCRIPT)], cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('PRIVATE_CANARY', result.stdout + result.stderr)
            self.assertEqual(secret.read_text(), 'PRIVATE_CANARY_NOT_FOR_OUTPUT')
            subprocess.run(['git', 'rm', '--cached', '.env'], cwd=root, check=True, capture_output=True)
            result = subprocess.run(['python3', str(SCRIPT)], cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
