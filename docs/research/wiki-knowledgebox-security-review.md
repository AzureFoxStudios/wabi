# Wabi Wiki Knowledgebox Security Review Brief

> **Status:** review draft. This is a design review target, not a claim that the implementation is secure.

## Review target

Wabi is a self-hosted chat platform with a first-class wiki. The proposed feature is **Wiki Knowledge Sync**:

```text
Wabi authority ── outbound paired sync ──▶ separate knowledgebox ──▶ local search / optional MCP / AI
```

The knowledgebox is intentionally separate from Wabi and Lore. Wabi remains canonical. The knowledgebox receives only owner-selected wiki content and exposes read/search operations to local tools or an AI client. It must not become a general Wabi API proxy.

## Questions for reviewers

### Trust boundary

- Does an outbound paired pipe materially reduce risk compared with an inbound AI read token?
- What network paths must be blocked so the knowledgebox cannot use Wabi as an SSRF or proxy primitive?
- Should synchronization be initiated only by Wabi, only by the knowledgebox, or use a long-lived outbound session?
- Is a same-host sidecar a meaningful boundary, or should Docker network isolation be mandatory?
- What is the minimum capability needed for replay and snapshot recovery?

### Identity and pairing

- Should pairing use a one-time code, a one-time token, or a local bootstrap socket?
- Can a knowledgebox credential be prevented from being accepted as Wabi Bearer/Bot authentication?
- Should identity be scoped to one server, pipe, collection, channel, or page set?
- What happens if a pairing secret leaks into shell history, Docker inspection, logs, or a reverse proxy?
- Is signed HTTPS enough for the MVP, with mutual TLS deferred?

### Data scope and retention

- Is per-channel selection enough, or should owners select pages?
- Should v1 send only current page bodies and omit revisions?
- How should images and attachments be represented?
- How are deletes propagated through source storage, search indexes, embeddings, caches, and backups?
- Should the pipe send raw markdown, sanitized rendered text, or both?
- What must the UI tell the owner about the knowledgebox operator's ability to read synchronized content?

### Abuse and resource exhaustion

- Can a compromised box repeatedly request snapshots or replay ranges?
- What quotas are needed per pipe, channel, operation, destination, and IP?
- What are safe bounds for page size, snapshot size, replay range, queue depth, and reconnect frequency?
- What happens when a box falls behind: bounded replay, forced snapshot, or operator intervention?
- Can reconnect storms degrade ordinary wiki writes?
- Does Wabi remain responsive while the box is slow, unavailable, or malicious?

### AI and prompt injection

- How is wiki text labeled as untrusted data rather than executable instruction?
- Can a malicious page influence an MCP agent's later tool calls?
- Should generated summaries be kept separate from source content and provenance?
- Should MCP expose only search/get/list-sources, with no URL fetch, shell, write, or proxy tools?
- Can source citations identify exact Wabi server, channel, page, section, and update time?
- Are embeddings optional and local-only for v1?

### Operations

- Can an ordinary self-host operator install, upgrade, backup, restore, reset, and remove the box without touching Wabi data?
- Can the box run with one container and one volume, without mounting Wabi's database or uploads?
- What sync status must Wabi show: destination, selected channels, cursor, backlog, last success, last error, stale/revoked state?
- Can the knowledgebox be wiped independently?
- Can the initial review run entirely against a disposable local Compose fixture?

## Required review fixture

Do not expose a production Wabi server. Reviewers should receive:

- a local Compose deployment;
- synthetic pages, including a prompt-injection-looking page;
- a protocol fixture client;
- explicit allowed targets;
- no real credentials, personal data, production hostname, or real database;
- a responsible-disclosure contact.

Findings should be categorized as protocol, authorization, data leakage/retention, resource exhaustion, AI/MCP integration, operational hazard, or documentation/UX ambiguity.

## Threat-model assumptions

- A remote attacker may discover a self-hosted Wabi URL.
- A pipe credential may leak.
- A paired knowledgebox may be compromised.
- A downstream AI may be induced to over-request or misuse its tools.
- Wiki content may be malicious or contain instructions aimed at an AI.
- The Wabi owner/root account and host are outside this boundary; no application feature protects against a fully compromised host owner.

## Minimum security properties

1. No AI-facing general crawl endpoint in Wabi.
2. No pipe credential accepted by ordinary Wabi routes.
3. Owner pairing is explicit, scoped, expiring, revocable, and rotatable.
4. Sync is bounded, resumable, idempotent, and deletion-aware.
5. Wiki writes never wait on the knowledgebox.
6. The knowledgebox has no Wabi write, arbitrary proxy, URL fetch, shell, or filesystem capability.
7. Search results include exact source provenance.
8. A deleted page disappears from source storage and search results.
9. Pipe traffic has independent quotas in addition to Wabi's global API limiter.
10. MCP, if enabled, exposes read/search only and marks page material as untrusted content.

## Residual risks to disclose

- A knowledgebox operator can read synchronized content.
- A compromised host owner can read or alter everything on that host.
- A remote AI provider may retain submitted content according to its own policy.
- Prompt injection cannot be eliminated by transport authentication.
- Rate limiting reduces resource abuse but does not prove intent safety.
- The knowledgebox is a smaller blast-radius boundary, not a magical AI security boundary.

## Sources motivating review

- OpenAI: https://openai.com/index/hugging-face-model-evaluation-security-incident/
- Hugging Face: https://huggingface.co/blog/agent-intrusion-technical-timeline
- OWASP Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- OWASP Excessive Agency: https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure/
- Agentic AI Security survey: https://arxiv.org/html/2510.23883v2
- Palo Alto Networks Unit 42: https://unit42.paloaltonetworks.com/agentic-ai-threats/

These sources motivate the questions. They do not certify the proposed protocol or implementation.
