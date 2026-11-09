import pathlib
import re
import unittest

CI = pathlib.Path(__file__).resolve().parents[2] / '.github' / 'workflows' / 'ci.yml'

CHECKOUT = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
RUST = 'dtolnay/rust-toolchain@633c1125191e55c620c8ae7d364073c0ead621c1'
NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'


def job_blocks():
    """Split ci.yml into {job_name: text} without needing a YAML parser."""
    text = CI.read_text()
    _, _, jobs = text.partition('\njobs:\n')
    blocks, name, lines = {}, None, []
    for line in jobs.splitlines():
        match = re.match(r'^  ([A-Za-z0-9_-]+):\s*$', line)
        if match:
            if name:
                blocks[name] = '\n'.join(lines)
            name, lines = match.group(1), []
        elif name:
            lines.append(line)
    if name:
        blocks[name] = '\n'.join(lines)
    return blocks


class CiWorkflowJobsTest(unittest.TestCase):
    def assertPinnedLikeTestJob(self, block, pins=(CHECKOUT, RUST, NODE)):
        self.assertIn('runs-on: ubuntu-latest', block)
        for pinned in pins:
            self.assertIn(pinned, block)

    def test_features_full_job_compiles_lore_and_full_feature_set(self):
        block = job_blocks().get('features-full')
        self.assertIsNotNone(block, 'ci.yml has no features-full job')
        self.assertPinnedLikeTestJob(block)
        build = block.index('STATIC_BUILD=1 npm run build')
        check = 'cargo check --locked -p wabi-server --features full'
        test = 'cargo test --locked -p wabi-server --features wabi-lore --lib -- lore'
        self.assertIn(check, block)
        self.assertIn(test, block)
        integration = (
            'cargo test --locked -p wabi-server --features wabi-lore --test "$(basename "$file" .rs)"'
        )
        self.assertIn(integration, block, 'features-full must run the feature-gated Lore integration tests')
        self.assertIn('core/crates/wabi-server/tests/lore_*.rs', block)
        # rust-embed needs frontend/build before the server crate compiles.
        self.assertLess(build, block.index(check))
        self.assertLess(build, block.index(test))

    def test_power_loss_job_runs_ignored_crash_injection_tests(self):
        block = job_blocks().get('power-loss')
        self.assertIsNotNone(block, 'ci.yml has no power-loss job')
        self.assertPinnedLikeTestJob(block, (CHECKOUT, RUST))  # wabidb needs no Node
        self.assertIn(
            'cargo test --locked -p wabidb --features test-harness --lib tests::power_loss -- --ignored',
            block,
        )

    def test_existing_jobs_still_present(self):
        self.assertTrue({'container-install', 'test', 'supply-chain'} <= set(job_blocks()))


if __name__ == '__main__':
    unittest.main()
