# Living markdown kanban — multi-Hermes fence

Use when two or more Hermes (or Hermes + OpenCode) sessions burn a shared showcase/plan board that is a **markdown checkbox file**, not only `hermes kanban` CLI.

Validated on Wabi showcase-prep 2026-08-01 (`docs/showcase-prep-kanban.md`): W0 A1–A6 + W1 L1–L6 closed under this protocol.

## Source of truth

- **Board file** = checkboxes + progress log + card counts.
- Plan doc = design SoT; **do not mid-flight edit the plan** while a card is claimed.
- Memory may hold a one-line board snapshot; the markdown file wins on conflict.

## Claim before edit

Before touching files for a card, append a progress-log line:

```
| YYYY-MM-DD | L3 | in progress | agent-A: lore /api URL prefix |
| YYYY-MM-DD | C1 | in progress | agent-B: #channel mentions |
```

Rules:
1. **One card = one owner.** Never two agents on the same card.
2. **One file-cluster = one owner.** Never two agents in the same cluster even on different cards.
3. Claim **before** first edit; close with checkbox `[x]`, one **done** log line, and **delete/replace** any stale `in progress` lines for that card.

### Scrub stale claims

Duplicate or leftover `in progress` lines (e.g. "L5 in progress | other Hermes" after L5 is done) create **false locks** and thrash. On every card close:

1. Checkbox → `[x]`
2. One `done` log row
3. Remove every `in progress` / `claimed` row for that card id
4. Update the wave **Card counts** status line

## File-cluster fence (showcase split that worked)

| Lane | Owns | Do not touch |
|------|------|--------------|
| Lore E2E | `LoreChannel.svelte`, `lore.ts`, `loreStore.ts`, `LoreChannelList.svelte`, `ChannelKind`/channels API wire, socket `normalizeChannel` for lore | `markdown.ts`, `navigateToRef.ts` |
| Channels nav | `markdown.ts`, `navigateToRef.ts`, mention/parser consumers | Any lore* / LoreChannel / wabidb ChannelKind |
| Notes wave | notes surfaces / DmHub notes tab | LoreChannel (except a one-line openNotes hook if Lore owns L6) |

**Serialize** any single huge surface file (e.g. LoreChannel L3→L8). Safe parallels observed: L3+C1, L4+C2, L6 tokenize + Notes wave. Unsafe: two agents on LoreChannel, ChannelSidebar+lore filters, socket hydrate, or domain kind at once.

## Hermes verify (never trust self-report)

After each card, captain/owner verifies:

1. Scoped diff vs pre-card baseline (`git status` / `git diff`)
2. Frontend: `cd frontend && bun run check` — treat **pre-existing `bun:test` module errors** as noise if count unchanged
3. Server/domain: `cargo check -p wabi-server --features addons` (and targeted lib tests when domain changed)
4. Grep for the load-bearing symbols (URL prefix, parser, export) — worker "all done" is not evidence

Final UI gate for Wabi = **Ronin real browser**, not headless (Skia crash).

## OpenCode / worker dispatch

- Foreground `opencode run` hard-caps around **600s**. Surgical cards (URL fix, id parse, small tokenize) → **in-session takeover**.
- Long isolated cards → background + notify, file allowlist, Python subprocess prompt (see `opencode-dispatch` / `wabi-opencode-dispatch`).
- On zero-output timeout or death: **do not re-dispatch the same prompt** into the same trap — finish in-session.

## Living kanban vs watch-doc

When both agents treat the **progress log as the claim bus**, a separate multi-agent watch doc is optional. Use `multi-agent-watch-doc` only if silence/thrash appears or the user names two long-lived sessions that need a chat relay. Do not fork a second coordination file by default.

## Handoff blurb (paste to peer)

```
SoT: docs/showcase-prep-kanban.md
Claim card in progress log before edits.
Done = scoped diff + bun/cargo as needed + checkbox + done log line + scrub in-progress.
One file-cluster per agent. Hermes verifies; no self-report green.
```
