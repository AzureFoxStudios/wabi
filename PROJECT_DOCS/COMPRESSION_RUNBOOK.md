# Compression Rollout Runbook

## Scope
- Branch: `work/compression-foundation-plan`
- Backend adds:
  - upload/download telemetry
  - static text response compression (brotli/gzip negotiation)
  - optional upload-at-rest gzip envelope (feature-flagged)

## Feature Flags
- `HTTP_TEXT_COMPRESSION_ENABLED=true`
- `HTTP_TEXT_COMPRESSION_MIN_BYTES=1024`
- `HTTP_TEXT_COMPRESSION_BROTLI_QUALITY=5`
- `HTTP_TEXT_COMPRESSION_GZIP_LEVEL=6`
- `UPLOAD_COMPRESSION_ENABLED=false` (default off for controlled rollout)
- `UPLOAD_COMPRESSION_MIN_BYTES=4096`
- `UPLOAD_COMPRESSION_GZIP_LEVEL=6`
- `UPLOAD_COMPRESSION_ROLLOUT_PERCENT=100` (set lower for canary)
- `UPLOAD_COMPRESSION_ROLLOUT_SALT=wabi-upload-rollout`

## Validation Commands
1. Build backend:
```bash
cd backend
npm run build
```

2. Local corpus benchmark (storage potential estimate):
```bash
cd ..
npm run bench:compression -- --dir uploads --max-files 500 --max-bytes 8388608
```

3. Smoke-check storage codec layering (compression + at-rest encryption):
```bash
npm run check:compression-storage
```

4. Read live compression config (admin auth required):
- `GET /api/admin/compression-config`

5. Read live telemetry (admin auth required):
- `GET /api/admin/compression-metrics`

6. Reset telemetry window (admin auth required):
- `POST /api/admin/compression-metrics/reset`

## Rollout Sequence
1. Enable only HTTP text compression first.
2. Observe p95 latency and CPU for 24h.
3. Keep upload compression disabled during this stage.
4. Enable upload compression for a small canary environment.
5. Compare:
   - `uploadStoredToOriginalRatio`
   - `downloadResponseToStoredRatio`
   - upload/download endpoint latency
   - CPU utilization under parallel uploads
6. Promote to wider rollout only if no regression threshold is breached.

## Regression Thresholds (Suggested)
- p95 latency increase <= 10%
- sustained backend CPU increase <= 20%
- zero decode/serve corruption errors
- no download incompatibility regressions
