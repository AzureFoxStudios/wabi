# Browser tool recovery — `browser_navigate` stuck on a bad URL

## Symptom
`browser_navigate` fails with something like:
```
Invalid URL 'whoops go back/tabs': No scheme supplied.
```
The tool ignores the URL you pass and replays a stale/crashed-tab string
("whoops go back/tabs" is Chrome's crashed-tab / tab-strip URL text). It repeats
on every call — a loop.

## Why it happens
The browser tool is backed by a **browser-harness** Python daemon
(`browser_harness.daemon`, usually under `~/.local/share/uv/tools/browser-harness`)
driving a long-lived Chromium
(`--user-data-dir=/home/Ronin/.browser-harness-chromium-profile`). The stale URL lives in
TWO places:
1. The daemon's Chromium profile (persisted tab state).
2. The **running Hermes agent process's in-memory `current_url`** — this is what replays
   it even after you kill the daemon.

## Fix (do in order)
1. Kill the daemon + its Chromium:
   ```
   pkill -9 -f browser_harness.daemon
   pkill -9 -f browser-harness-chromium-profile
   pkill -9 -f "remote-debugging-port=9222"
   ```
2. Wipe the corrupted profile so a fresh one spawns:
   ```
   rm -rf /home/Ronin/.browser-harness-chromium-profile
   ```
3. **Restart the Hermes CLI/agent.** This is the actual fix — it clears the agent's
   in-memory `current_url`. Killing the external daemon alone (steps 1–2) is necessary
   but NOT sufficient; the agent process keeps replaying the bad URL. Ending the session
   and relaunching Hermes spawns a clean daemon + clean profile, and `browser_navigate`
   works again.

## Don't
- Don't keep retrying `browser_navigate` with different URLs inside the same session —
  the agent's cached `current_url` wins every time (loop warning).
- Don't grep `~/.hermes` for `current_url` expecting a state file — in this environment
  the bad URL is NOT persisted to a Hermes json; it's in the agent process memory.
- Don't waste turns "fixing" it from inside the session. Note it, restart the agent.

## Note for Wabi debugging
When the browser tool is down, verify frontend fixes another way: build unminified /
esbuild and capture `pageerror` via Playwright (`scripts/verify_spa_boot.mjs`), or just
deploy and let the user confirm in their (working) real browser. The headless Chromium
OOMs on the Wabi SPA ("page dies") — that is a Playwright artifact, not the app crash;
cross-check with the unminified build (0 errors = minifier issue, see
references/terser-minify-boot-crash.md).
