# Other AI Microtask Guide

This is supplemental.
For full cleanup-campaign handoff, use [AI_CLEANUP_HANDOFF_GUIDE.md](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/PROJECT_DOCS/AI_CLEANUP_HANDOFF_GUIDE.md).

Use external models as narrow reviewers, not autonomous repo owners.

## Best Uses

- Pick the next smallest safe extraction seam in one exact file range.
- Review one extracted module for behavior drift against the original block.
- List hidden couplings in one exact handler cluster.
- Review one patch for regressions, missing cleanup, or permission drift.
- Judge whether a fallback or legacy branch is actually safe to delete.

## Avoid

- "Understand the repo."
- "Finish the refactor."
- "Clean up the backend."
- Anything that asks the model to roam the codebase before answering.

## Rules

- Give one file or one narrow line range.
- Ask one question.
- Require a short fixed output format.
- Keep expected runtime under a minute.
- Treat the answer as advisory until it is reviewed locally.

## Good Prompt Shape

```text
Read only:
- backend/src/server.ts lines 7200-7600
- backend/src/services/groupCallLifecycle.ts

Task:
Review whether the extraction preserved behavior.

Output format:
REGRESSIONS:
- ...
- ...

MISSING SIDE EFFECTS:
- ...
- ...

SAFE NEXT STEP:
- ...

Do not propose broad repo rewrites.
Do not discuss unrelated files.
Keep it under 12 bullets.
```

## Best Task Types For This Repo

### 1. Seam Selection

```text
Read only backend/src/server.ts lines 7800-8450.

Answer in this format:
SAFE SEAM:
<one short paragraph>

API:
- ...
- ...
- ...

RISKS:
- ...
- ...
- ...
```

### 2. Behavior Diff Review

```text
Read only:
- backend/src/server.ts lines 7200-7445
- backend/src/services/groupCallLifecycle.ts

Task:
List any behavior changes between the old inline handlers and the extracted module.

Output:
REGRESSIONS:
- ...

UNCHANGED CRITICAL BEHAVIOR:
- ...
```

### 3. Hidden Coupling Audit

```text
Read only backend/src/services/channelMutationHandlers.ts.

Task:
List all external state this module implicitly depends on.

Output:
COUPLINGS:
- ...

MOST FRAGILE DEPENDENCY:
- ...
```

## Recommended Workflow

1. Run the external model on one microtask.
2. Save the output to a file in `PROJECT_DOCS/` or paste it into chat.
3. Review it locally before changing code.
4. Apply only the high-confidence part.
5. Re-run local verification immediately.

## File Naming

- `PROJECT_DOCS/tmp_claude_review_01.md`
- `PROJECT_DOCS/tmp_opus_seam_01.md`
- `PROJECT_DOCS/tmp_model_diff_review_01.md`

Short, disposable files are better than long running notebooks.
