# External AI Worker Test Run

Status snapshot: 2026-04-16

This is the concrete test plan for trying a managed multi-AI workflow on Wabi.

Goal: use external CLIs as workers while Codex stays in charge of planning, review, and integration.

## Available Local Workers

- `gemini`: `/home/Ronin/.npm-global/bin/gemini`
- `opencode`: `/home/Ronin/.opencode/bin/opencode`
- `claude`: `/home/Ronin/.local/bin/claude`

## Recommended Manager Model

Use this role split:

- Codex: planner, reviewer, integrator, verifier
- Gemini: analysis and repo reading
- Opencode: implementation attempt
- Claude: second opinion or diff review

Do not let any external worker apply changes blindly without Codex reviewing them.

## Tomorrow Checklist

1. Enter the repo:
   `cd /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi`

2. Create a scratch branch or worktree:
   `git checkout -b external-ai-test-$(date +%Y%m%d)`

   Safer alternative:
   `git worktree add ../wabi-external-ai-test -b external-ai-test`

3. Verify the CLIs are callable:
   `gemini "Reply with exactly OK."`
   `opencode run "Reply with exactly OK."`
   `claude -p "Reply with exactly OK."`

4. If auth is missing, fix that first:
   `opencode providers list`
   `opencode providers login`
   `claude auth status`
   `claude auth login`

   Gemini usually prompts on first real use. If the one-shot test does not return normally, complete its login flow first.

5. Start with a read-only dry run before any edits.

## Read-Only Dry Run

Ask each worker for a bounded, low-risk task. Do not let them edit yet.

### Gemini

```bash
gemini "In this repository, identify one small self-contained cleanup task. Do not edit files. Return only: target file, why it is low risk, and the verification command."
```

### Opencode

```bash
opencode run --dir /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi "Identify one small self-contained cleanup task in this repo. Do not edit files. Return only: target file, why it is low risk, and the verification command."
```

### Claude

```bash
claude -p "In this repository, identify one small self-contained cleanup task. Do not edit files. Return only: target file, why it is low risk, and the verification command."
```

Then compare the three answers. If they point at wildly different things, do not proceed to editing yet.

## First Real Write Test

Use one small task, one file, one verification command.

Good first-test characteristics:

- one file or one tiny module
- no schema migrations
- no auth/session logic
- no broad search-and-replace
- easy verification

Bad first-test characteristics:

- giant files like `backend/src/server.ts`
- socket/runtime/session logic
- multi-file refactors
- anything with unclear ownership

## Ready-To-Paste Prompt For Codex

Use this with Codex tomorrow:

```text
Use external AI workers for this task.
Use gemini for analysis, opencode for implementation, and claude for review.
You stay as orchestrator, reviewer, and final decision-maker.

Rules:
- Start with a read-only dry run and summarize what each worker recommended.
- Pick one small low-risk task only.
- Do not apply external output blindly.
- Review all suggested changes yourself before integrating anything.
- Keep the first write test to one file or one tiny module.
- After changes, run the relevant verification command and summarize the result.
- Write down what worked and what did not in PROJECT_DOCS/EXTERNAL_AI_WORKER_TEST_RUN.md.
```

## Suggested First Test Sequence

1. Run the three read-only prompts above.
2. Pick the lowest-risk shared recommendation.
3. Ask Opencode to implement it.
4. Ask Claude or Gemini to review the proposed change.
5. Have Codex inspect the result and either accept, revise, or reject it.
6. Run verification.
7. Record what happened.

## Example Implementation Command

This is the pattern, not a fixed task:

```bash
opencode run --dir /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi "Implement a small low-risk cleanup in <target-file>. Stay within that file unless strictly necessary. Explain what you changed and why."
```

## What Success Looks Like

A successful first test is not “the AI did a huge refactor.”

A successful first test is:

- all three tools ran
- Codex could compare their output
- one small change was made
- verification still passed
- the workflow felt controllable

## What To Record After The Test

Append these notes after the run:

- which worker was best at analysis
- which worker was best at implementation
- which worker was noisy or unreliable
- whether any worker ignored scope
- whether Codex orchestration felt useful or redundant
- whether this should be used only for bounded tasks or also for larger refactors

## 2026-04-17 Trial Notes

- Scope tested: read-only analysis on the remaining `backend/src/server.ts` voice/call subsystem during the engine-room refactor.
- Codex stayed as planner, editor, integrator, and verifier.
- Opencode was useful for bounded seam identification. Its best output was not code, but a concrete warning about the coupling between `socketVoiceSubscriptions` and the voice recording runtime.
- Claude CLI did not return usable repo-analysis output in repeated attempts, including a clean retry after an accidental interruption, so it is not reliable enough yet to put on the critical path for this repo.
- Net result: external workers are currently useful here as sidecar analysts, not autonomous implementers.
- Current recommendation:
  - keep using Opencode for narrow read-only seam/review questions
  - do not rely on Claude for repo analysis until its CLI behavior is understood
  - keep Codex as the only writer/integrator for `backend/src/server.ts` refactors

## Current Best Guess On Wabi

This workflow is best suited for:

- small backend route cleanup
- docs cleanup
- type tightening in isolated modules
- focused review/comparison work

This workflow is not the first thing to use on:

- `backend/src/server.ts`
- large socket/session refactors
- broad architectural moves

Those are still manager-heavy tasks where external workers should be treated as assistants, not autonomous owners.
