# Runtime + Database Benchmark Results

Last updated: 2026-02-18

## Goal

Evaluate practical deployment combinations for Wabi:

- Runtime: Node vs Bun
- Database path: SQLite vs Postgres vs libSQL

Primary decision criteria:

- Correctness
- Stability
- p95 latency
- Peak RSS memory

## Test Matrix (What Was Actually Run)

1. Node + `better-sqlite3`
2. Bun + `bun:sqlite`
3. Bun + `Bun.SQL` (`adapter: "sqlite"`)
4. Bun + `libSQL` local file (`@libsql/client`, `file:` URL)
5. Node + Postgres (`pg`)
6. Bun + Postgres (`pg`)

## Key Results

### SQLite Track (heavy profile: 5 runs, 10k inserts, 5k queries, 1k tx)

Node + `better-sqlite3`:

- median p95: `508ms`
- median peak RSS: `49.18MB`

Bun + `bun:sqlite`:

- median p95: `581ms` (`+14.37%` slower vs Node SQLite)
- median peak RSS: `216.79MB` (`+340.80%` vs Node SQLite)
- Result: `NO-GO`

Bun + `Bun.SQL` (sqlite adapter):

- median p95: `414ms` (`-18.50%` faster vs Node SQLite baseline run)
- median peak RSS: `225.30MB` (`+358.11%` vs Node SQLite)
- Result: `NO-GO` (memory gate fails hard)

### libSQL Track (default profile: 3 runs)

Bun + `libSQL(file)`:

- median p95: `423ms` (vs Node SQLite `310ms`, `+36.45%`)
- median peak RSS: `367.45MB` (vs Node SQLite `45.80MB`, `+702.21%`)
- Result: `NO-GO`

### Postgres Runtime Parity Track

Node + Postgres (`pg`) and Bun + Postgres (`pg`) were near parity.

Representative run:

- Node p95: `186ms`
- Bun p95: `182ms` (`~2%` faster)
- Node peak RSS: `147.73MB`
- Bun peak RSS: `156.33MB` (`~6%` higher)
- Result: `GO` (runtime parity acceptable)

### Node SQLite vs Node Postgres (fresh 5-run comparison)

Node + SQLite:

- median p95: `444ms`
- median peak RSS: `50.64MB`

Node + Postgres:

- median p95: `184ms` (`-58.56%` faster vs Node SQLite)
- median peak RSS: `173.07MB` (`+241.76%` vs Node SQLite)

Interpretation:

- Postgres gives much lower tail latency in this workload.
- SQLite stays much leaner in memory footprint.

## Additional Compatibility Findings

`better-sqlite3` on Bun (Windows, Bun 1.3.2):

- Fails with `ERR_DLOPEN_FAILED`
- Bun reports package not yet supported
- Tracking issue: https://github.com/oven-sh/bun/issues/4290

## Final Determination

1. **Normal mode (lightweight/small servers):** `Node + SQLite`
2. **Community mode (larger/more active servers):** `Postgres` (runtime can be Node or Bun)
3. **Bun + SQLite family today:** not production-ready for Wabi based on measured memory/latency behavior.

## Setup Splitter Work Added

To support mode selection at setup time:

- Added `scripts/setup.sh` (asks Tiny vs Community first)
- Added `docker-compose.community.yml` (Postgres sidecar profile/override)

Current startup commands:

- Normal mode: `docker compose up -d --build`
- Community mode: `docker compose -f docker-compose.yml -f docker-compose.community.yml up -d --build`

## Notes

- Frontend/client install size is mostly unaffected by SQLite vs Postgres choice unless a local backend runtime is bundled with desktop app.
- Postgres cost is primarily server-side operational footprint.
