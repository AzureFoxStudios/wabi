You are working in the Wabi repo (/var/home/Ronin/wabi). Svelte 5 + plain CSS frontend. Dark nebula theme; semantic tokens live in frontend/src/styles/tokens.css — use semantic tokens, never raw hex. Do NOT touch src-tauri/ or lib/tauri-*.ts. Do NOT commit anything.

TASK: Forum "+" button placement — symmetric plus buttons in both column headers.

Files you may modify ONLY:
- frontend/src/lib/components/ForumChannel.svelte
- frontend/src/styles/components/forum.css

Current state (already verified):
- ForumChannel.svelte ~line 291-305: the Categories pane header (`.forum-category-header`) currently contains BOTH buttons: `.forum-add-category-btn` (label "+ Tag") and `.forum-new-thread-btn` (label "+", calls handleNewThread, gated on canCurrentUserPost).
- The threads column (`.forum-post-list`, ~line 387) has NO header — it goes straight to the thread rows / empty state.
- forum.css already has `.forum-post-list-header` (~line 208) and `.forum-post-list-header-count` (~line 220) styles defined.
- `.forum-new-thread-btn` is a 28px round accent button (forum.css line 39).

Required changes:
1. REMOVE the `.forum-new-thread-btn` button from the Categories header (the `{#if canCurrentUserPost}<button class="forum-new-thread-btn" ...>` block around line 301-303).
2. ADD a header row at the top of the threads column, inside `.forum-post-list` before the empty-state/{#each} block:
   <div class="forum-post-list-header">
     <span>{activeCategory ?? 'Threads'}</span>
     {#if canCurrentUserPost}
       <button class="forum-new-thread-btn" on:click={handleNewThread} title="New Thread">+</button>
     {/if}
   </div>
   The label shows the active category name when a category filter is active, otherwise the literal text "Threads". Use the existing `activeCategory` variable (it is `string | null`; render `{activeCategory || 'Threads'}`).
3. RESTYLE the add-category button: change its label from "+ Tag" to just "+", keep title="Add category", and update `.forum-add-category-btn` CSS to match `.forum-new-thread-btn` geometry: 28px x 28px, border-radius: var(--radius-full), same font-size/weight/line-height, inline-flex centered. Keep its current transparent/border-subtle neutral styling (it should NOT become accent-filled — the thread button stays the accent one). Update the hover rule to keep working.
4. Ensure `.forum-post-list-header` CSS lays out as: flex row, space-between, centered items, padding matching `.forum-category-header` (check that selector ~line 24-37 for reference), uppercase label styling to match the Categories header label, flex-shrink: 0. Adjust the existing rule if needed.
5. The add-category inline input (`addCategoryMode`) and the rename pencil must keep working — do not touch that logic.

VERIFY before finishing:
- cd /var/home/Ronin/wabi/frontend && bun run check — must show no NEW errors in ForumChannel.svelte (there are 6 pre-existing errors elsewhere in the repo from bun:test module resolution — those are NOT yours, ignore them).

Write a short report to audit/worker-a-forum-plus-report.md listing exactly what you changed and the bun run check result.
