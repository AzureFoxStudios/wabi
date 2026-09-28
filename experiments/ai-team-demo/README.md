# One task, shared progress

**Superseded as the primary demonstration:** Ronin requested proof inside the
actual app. See the [live Wabi test and its limitations](../../docs/testing/PROJECT_IN_APP_PROOF_2026-09-28.md).
This standalone page is retained only as a workflow sketch; it does not prove
Wabi integration.

A local, functional developer-workflow prototype for the discussion in
[Pokee's developers as Wabi users](../../docs/plans/2026-09-28-pokee-developer-workflow.md).
It demonstrates how a development team could use its existing assistants with
Wabi. It does not implement or train an AI model, connect to Pokee, or require
Pokee's source code.

## Run the demonstration

Requires Node 22; no package installation or provider credential is needed for replay.
From the repository root:

```bash
DEMO_PORT=47321 node experiments/ai-team-demo/server.mjs
```

Open the loopback URL printed at startup. Use a different free port if necessary.
Each launch creates a fresh temporary state directory; its path is printed alongside
the URL. Stop this prototype process before reusing its port. To resume a particular
run, set `DEMO_STATE_DIR` to that printed path. Previous runs are not deleted.

Click the five steps:

1. **Reproduce bug:** run six fixed checks against the original defective function.
2. **Try competing claims:** two real concurrent HTTP requests compete for one edit
   claim; only one wins. A scripted coordination message gives the other session
   a review role.
3. **Load AI proposal:** copy the inspected, pinned model proposal into the owner's
   separate working folder. Inspect the original and proposed source on the card.
4. **Run verification:** copy that exact proposal to the other working folder and
   execute the six checks there. The recorded model review is displayed separately
   from the real test output.
5. **Accept this version:** simulate a human acceptance decision tied to the current
   card revision and the tested source hash. Nothing is merged or deployed.

Add a review note, inspect runner output under Checks, or reload the page to see
the saved record. Handoff summarizes the record for the next session; it is a
deterministic summary, not a third live AI session. Restarting with the same state
directory restores the accepted decision, discussion and evidence.
After acceptance, **Start a fresh demo** saves a `completed-<revision>.json`
archive with the full record and embedded test output, then opens an empty run.
The fixed disposable workspace files are reused; completed records are retained.

## What is real and what is staged

| Part | Boundary |
| --- | --- |
| Builder and reviewer output | Two separate single-turn API sessions using `cohere/north-mini-code:free`, captured on 2026-09-28. Same model, distinct contexts. Responses are replayed; there is no live AI tool loop in the browser demo. |
| Model proposal | Comments and blank lines removed from the inspected source; executable statements unchanged. Raw response retained in `recording.json`. `approved.json` pins the source and test hashes. |
| Claim contention | Actual competing HTTP requests, serialized compare-and-set in one local Node process. Not distributed coordination. |
| Coordination dialogue | Scripted messages and role switch. Not evidence of autonomous negotiation. |
| Files and tests | Real separate directories and Node processes; six regression checks run locally. Separate folders are not a security sandbox. Only the fixed inspected fixture can be executed through this server. |
| Discussion and review | Functional local prototype with saved JSON state. Not production Wabi comments, WabiDB events, Lore history or authenticated human review. |
| Demo identities | Illustrative browser-controlled roles. Loopback Host/Origin/token checks reduce accidental cross-site actions; they are not production authentication or an authorization system. |
| Persistence | Temporary-directory JSON replacement and restart recovery. No fsync/power-loss durability guarantee, multi-process lock, lease or remote failover claim. Run only one process per state directory. |
| Source authority | Disposable fixture only. No production repository edits, remote Linux box, Git merge, Lore push/pull or computer-to-computer handoff. |

The demo's server exposes fixed actions, not a general code/shell execution API.
It rejects source changes before verification and before acceptance. Child tests
receive a minimal environment, not provider credentials. Model claims that tests
pass are not accepted as evidence. The runner requires complete test output.

## An instructive failure

The initial free-model request ignored JSON mode. The capture tool now preserves
unstructured responses for inspection instead of treating a parse failure as a
successful action. A subsequent proposal still mishandled duplicates already in
the current list, and its static reviewer claimed that tests passed without
executing them. That recording is retained as `recording.rejected.json`.

We added the missing regression and captured a corrected proposal. A test proves
the earlier proposal fails the expanded suite. The accepted proposal passes all
six checks. The final static review also uses “tests pass” language, explicitly
disclaims execution, and remains merely a quoted model opinion. Actual runner
evidence is saved independently. This is a useful demonstration of why a shared
review record needs executable checks and human decisions, not just agent chat.

## Verification

The completed browser run is saved in [`acceptance.json`](acceptance.json): one
successful claim and one conflict, failing baseline, six passing candidate
checks, saved review note and exact-version acceptance. The real browser also
confirmed recovery after server restart and the fresh-demo control. The eight
workflow regression tests passed on 2026-09-28. This is local prototype evidence,
not a production Wabi or Lore acceptance report.

```bash
node --test experiments/ai-team-demo/demo.test.mjs experiments/ai-team-demo/http.test.mjs
```

Eight regression tests cover concurrent claims, duplicate-request replay,
non-owner/stale writes, acceptance before checks, source version mismatch,
source tampering, failed evidence, persistence, the rejected model proposal,
and HTTP Origin/token/Host controls. Tests use disposable temporary folders and
an ephemeral loopback listener. Environments that block child stdout or loopback
listeners cannot run the acceptance suite faithfully; use a permitted local
execution environment rather than ignoring the missing evidence.

## Optional new model capture

`record-model.mjs` is an explicit opt-in recording tool. It sends only the
disposable fixture, checks and proposal to the pinned free OpenRouter route.
There is no paid fallback. Configure `OPENROUTER_API_KEY` in the process environment
or explicitly supply `DEMO_PROVIDER_ENV_FILE` pointing to an existing credential
file, then run:

```bash
node experiments/ai-team-demo/record-model.mjs
```

It saves `recording.proposed.json` as data and never executes the response.
Do not promote a new response automatically: inspect the complete source, rerun
the tests, preserve the raw output, and deliberately update the pinned fixtures
and hashes. The server is not intended to execute arbitrary generated programs.

## Next product slice

Move the useful interaction into actual Wabi Project cards: authenticated card
comments, explicit review requests, scoped ownership and exact-version evidence
linked to the team's existing repository. Adapt an existing assistant to those
tools. Add a Lore round trip only when it proves a concrete artifact handoff.
Keep one real task as the acceptance target before adding remote execution or a
multi-computer scheduler. This prototype is a discussion aid, not evidence that
those production integrations already exist.
