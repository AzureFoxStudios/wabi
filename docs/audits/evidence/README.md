# Evidence for the 2026-11-03 backend security audit

All artifacts in this directory were produced in the sandbox on 2026-11-03 and
are committed so a reviewer can re-check claims without trusting prose.

| File | What it proves |
| --- | --- |
| `ci-enforcement-2026-11-04.txt` | re-landing of the workflow half (SHA pins, Node2Shell floors, fingerprint steps, supply-chain job): pin check 94/94, gate advisory+blocking exit 0, gate unittests 57/57 with migration applied |
| `npm-audit-before.json` | `npm audit --json` against `HEAD`'s `frontend/package.json` + lock (14 vulns: 2 critical, 5 high, 7 low) |
| `npm-audit-after.json` | same command against the patched lock (10 vulns: 1 critical, 2 high, 7 low) |
| `bun-test-before.txt`, `bun-test-after.txt` | full `bun test --isolate src/lib` on Bun 1.4.4, baseline vs patched: 2892 pass / 3 skip / 6 fail / 58008 expects / 2901 tests, identical test-name sets |
| `svelte-check-before.txt`, `svelte-check-after.txt` | `npm run check`: 42 errors / 108 warnings in both, byte-identical output |
| `vite-build-after.txt` | `npm run build:only` (`vite build`) succeeds on the patched tree |
| `npm-ci-before.txt`, `npm-ci-after.txt` | `npm ci --ignore-scripts` in the verification harness |
| `ioc-spotcheck-2026-11-03.txt` | 5 clean locked packages re-checked against 80 exact IOCs / 5 names / 19 scopes and live registry metadata |
| `rustsec-2026-11-03.{md,json}` | offline RustSec matcher over 7 Cargo.lock files (948 packages, 436 2026 advisories) → 43 matches |
| `supply-chain-{advisory,blocking}.txt` | `scripts/security/supply_chain_check.py` in both modes |
| `pin-actions-check.txt` | all GitHub Actions pinned to 40-char SHAs |
| `supply-chain-unittests.txt` | `python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v` → 57 tests OK |

## Reproducing the frontend verification harness

The real tree cannot complete `npm ci` in a registry-restricted environment
because `frontend/package-lock.json` resolves `xlsx@0.20.3` from
`https://cdn.sheetjs.com/...` (see finding F-09 / backlog B-10). To run the
suite anyway, the harness:

1. copies `frontend/` to a temp dir (excluding `node_modules`, `.svelte-kit`,
   `build`);
2. removes **only** the `xlsx` entry from the temp `package.json` and
   `package-lock.json`;
3. runs `npm ci --ignore-scripts --no-audit --no-fund`;
4. writes a minimal `node_modules/xlsx` stub (`index.js`, `index.d.ts`,
   `package.json`) so type-only imports and the test file resolve;
5. copies repo-root `shared/` to the temp dir's parent so the
   `../../../../shared/...` imports in frontend source compile.

Steps 1–5 were applied identically to the **HEAD** dependency set and the
**patched** dependency set. The 6 failing tests are all in
`src/lib/workspaces/sheets/fileAdapter.test.ts` and need the real `xlsx` XLSX/ODS
round-trip implementation; they fail identically before and after. No failure is
attributable to the four version bumps.

## Reproduction commands

```bash
python3 scripts/security/pin_actions.py --check
python3 scripts/security/supply_chain_check.py --mode advisory
python3 scripts/security/supply_chain_check.py --mode blocking
python3 scripts/security/npm_audit_gate.py --mode blocking
python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
python3 scripts/security/generate_authz_matrix.py
python3 scripts/security/generate_cve_register.py
git clone --depth 1 https://github.com/RustSec/advisory-db.git /tmp/advisory-db
python3 scripts/security/rustsec_report.py /tmp/advisory-db \
  --out docs/audits/evidence/rustsec-2026-11-03
```

## What is deliberately absent

No `cargo audit` / `cargo deny` / `cargo tree --duplicates` / `cargo check` /
`cargo test` / desktop `cargo build` log exists: there is no Rust toolchain in
this sandbox. No GitHub Actions run log exists either. The audit report
(`../2026-11-backend-security-audit.md`, §4 and §6) lists these as open items.
