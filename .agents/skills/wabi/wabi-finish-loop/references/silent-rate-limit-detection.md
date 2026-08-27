# Silent rate-limit detection for OpenCode free-tier workers

## Problem
`opencode run ... --model opencode/deepseek-v4-flash-free` (or `laguna-s-2.1-free`)
can silently rate-limit mid-session. The binary prints only its startup banner:

```
> build · deepseek-v4-flash-free
```

and exits 0 with **no model response**. This looks like success (exit 0) but
produced zero work. Workers that depend on this pattern appear to run but never
actually call the model.

## Detection (Hermes side)
1. Check log size growth after 60s:
   ```bash
   wc -l /tmp/dispatch_v1.log   # if ≤3 lines after 60s, model is not calling
   ```
2. Check DB session:
   ```sql
   SELECT id, time_created, time_updated FROM session
   WHERE time_updated > <dispatch_epoch> ORDER BY time_updated DESC LIMIT 5;
   -- If time_updated ≈ time_created (no delta), no messages were processed.
   ```
3. Check for `opencode run` processes:
   ```bash
   ps aux | grep "opencode run" | grep -v grep
   -- If absent but log has banner only: killed by rate-limit.
   ```

## Recovery
1. Kill stale python wrappers + orphaned opencode processes:
   ```bash
   pkill -9 -f "dispatch_v1.py"
   pkill -9 -f "opencode run"
   ```
2. Check opencode.ai billing state — free tier may have been revoked:
   ```bash
   opencode run 'echo test' --model opencode/deepseek-v4-flash-free
   # If "No payment method" or banner-only output → free tier unavailable.
   ```
3. Fall back to Hermes captain (direct implementation) or switch to a paid
  provider. Do NOT retry the same model — it will silently fail again.

## Prevention
- Smoke-test with full prompt + timeout before dispatching workers:
  ```bash
  timeout 120 opencode run 'Respond with exactly: OPENCODE_SMOKE_OK' \
    --model opencode/deepseek-v4-flash-free 2>&1 | tail -5
  # Must contain "OPENCODE_SMOKE_OK", not just the banner.
  ```
- If smoke-test times out (>120s) or returns banner-only: do not dispatch workers.
  Switch to Hermes captain or report the model outage to the user.