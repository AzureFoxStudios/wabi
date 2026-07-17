# Calling / CSP notes (wabi.chat 2026-07-15)

## User report

- Login and first-time owner setup work on https://wabi.chat  
- **Cannot call**  
- Console:
  - Failed load: `https://static.cloudflareinsights.com/beacon.min.js/...`
  - CSP blocks that script: `script-src 'self' 'unsafe-inline'` (no cloudflareinsights host)
  - CSP blocks **eval**: `script-src` missing `'unsafe-eval'` (stack in hashed app JS)

## Analysis

### 1. Cloudflare Insights beacon (noise / CF inject)

CF Web Analytics / Insights injects a third-party script. Our Caddy/tunnel CSP is intentionally strict (`script-src 'self' 'unsafe-inline'` only). So the **browser correctly blocks the beacon**.

- This alone should **not** break calling.
- Fix options (pick one later):
  - Disable Cloudflare Web Analytics / Insights on the zone, or  
  - Stop injecting beacon, or  
  - (Not preferred) widen CSP to allow `static.cloudflareinsights.com`

### 2. `unsafe-eval` blocked (more serious)

App bundle hit a code path that wants `eval` / `new Function`. CSP without `'unsafe-eval'` kills it.

Likely suspects to verify later (not proven yet):

- Some WASM / codec / livekit / worker bootstrap path  
- A bundler runtime that still uses eval in a branch  
- An extension or injected script (less likely for first-party hash file)

**Next debug (when coding again):**

1. Reproduce call on **Tailscale origin** `http://100.96.11.45:3001` vs `https://wabi.chat`  
   - If Tailscale works and CF doesn’t → CF/CSP/tunnel headers  
   - If both fail → app/mediaDevices/transport  
2. On failing page:  
   `location.href`, `isSecureContext`, `!!navigator.mediaDevices`  
3. Find which module needs eval (stack / source map) before loosening CSP  
4. Prefer **remove eval dependency** over adding `'unsafe-eval'` site-wide

### 3. Separate known calling footgun

Non-secure contexts (plain LAN HTTP) → `mediaDevices` undefined.  
`https://wabi.chat` **is** secure context, so that is not the wabi.chat-specific issue.

## Priority when resuming calling work

1. Confirm call on Tim direct port (Tailscale) without CF CSP  
2. Fix root cause of eval (or minimal CSP exception with justification)  
3. Turn off CF Insights to silence beacon noise  
4. Re-test DM + voice channel call  

## Status

- Product usable for **login / first setup** on public URL  
- **Calling blocked** pending CSP/eval + media path investigation  
- Helper-node smoke plan is independent: use Tailscale Tim URL  
