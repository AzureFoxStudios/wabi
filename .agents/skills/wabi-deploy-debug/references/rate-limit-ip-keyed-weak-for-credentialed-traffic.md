# Rate Limit: IP-Keyed, Weak for Credentialed Traffic

**Status:** real control, wrong key for the AI-swarm scenario.

## What exists

`core/crates/wabi-server/src/rate_limit.rs` + `main.rs:883` wire a tower-governor rate limiter across the whole API router:

- `WABI_RATE_LIMIT_RPS` — requests per second (default 10).
- `WABI_RATE_LIMIT_BURST` — burst bucket (default 20).
- `RateLimitState::new(rps, burst)` → `rate_limit_middleware` applied to the router.
- Health checks are excluded (mounted separately, no rate limit).

## How the quota is keyed

`check_rate_limit` in `rate_limit.rs:70` keys the quota on **remote IP** by default. That is fine for anonymous traffic and for the "someone finds the URL and hammers it" case.

## Why IP-keyed is weak for the AI-access scenario

Once an owner hands out a credential (bot token, ingest secret, whatever shape the separate box takes), IP keying stops helping in the ways that matter for a swarm:

- A single owner's AI agent rotating IPs would not trip the IP bucket, so a legit-looking credential could still flood the server.
- Multiple real users behind one NAT share one bucket, so a tight IP limit punishes legitimate concurrently-connected humans.
- The Mythos / HuggingFace-incident-style worry is exactly credentialed-but-abusive traffic, where the credential is real but the rate is not. IP keying does not model that.

## What would actually address the concern

Per-credential rate limiting — key the quota on the authenticated identity (user id, bot id, or ingest secret id) rather than IP — so each credential gets its own bucket. That is the control co-dev was pointing at: "you can rate limit requests" only helps if the rate limit actually tracks the thing that holds the credential, not the network path it happens to come from.

The IP key is not wrong for the public API generally; it is just insufficient as the only limiter on a credentialed AI-read surface. If an ingest mount is added (e.g. `/api/ingest`), applying a tighter per-credential limiter there — separate from the global IP-limited router — is the shape that matches the threat model.
