# Wabi Frontend Component Decomposition — Handoff Document

Last updated: 2026-05-15

## Status: Phase 5 — Active Extraction (Settings + Other God Components)

---

## Part 1: Settings.svelte Extraction (Hermes)

### Completed ✅
- ProfileSettingsTab.svelte created (~387 lines)
- Wired into Settings.svelte shell with event forwarding
- Settings.svelte: **8,033 → 7,833 lines** (-200)

### Remaining — Hermes will continue
| Tab | Line Range | Size | Notes |
|-----|-----------|------|-------|
| Audio | ~4451-4900 | ~450 lines | Mic/camera/sound/device selects |
| Notifications | ~4900-5300 | ~400 lines | Sound toggles, ringtones |
| Accessibility | ~5300-5450 | ~150 lines | Role colors, message density |
| Appearance | ~5450-5750 | ~300 lines | Theme, fonts, animations |
| Server | ~5750-5800 | ~50 lines | Server info, invites |
| Addons | ~5800-7200 | ~1,400 lines | **THE BEAST** — addon management |
| Emojis | ~7200-7350 | ~150 lines | Emoji picker, bulk upload |
| Storage | ~7350-7400 | Already <StorageSettings /> | Verify imports |
| Admin | ~7400-8000 | ~600 lines | Admin panel, donation config |
| About | ~8000-8033 | ~33 lines | Version info |

**Target**: Settings.svelte shell → ~400-500 lines

---

## Part 2: Other God Components (OpenCode / Iyoku / Ironin)

### Already Completed by OpenCode ✅
| File | Before | After | What Happened |
|------|--------|-------|---------------|
| ServerSwitcherPanel.svelte | 1,921 | 1,020 | 901-line <style> → styles/components/server-switcher.css |
| MessageList.svelte | 3,334 | 2,381 | MessageItem (7), MessageItemContent (1,318), ImageLightbox (259), VideoLightbox (44) extracted |

### TODO: Assign to Iyoku / Ironin

**Target per file: ~500 lines average**

| File | Current Lines | Decomposition Plan | Target Shell | Assignee |
|------|--------------|-------------------|--------------|----------|
| **MapWorkspace.svelte** | 2,493 | MapRenderer (~800), SearchPanel (~400), PlaceDetailPanel (~600), OverlayLayer (~200) | ~200 | TBD |
| **ChannelSidebar.svelte** | 2,026 | ChannelListTree (~700), VoiceChannelPanel (~400), ThreadListView (~300), ServerBannerSection (~200) | ~200 | TBD |
| **DMMessageView.svelte** | 1,414 | Header (~200), MessageThread (~800), DMMemberList (~200) | ~150 | TBD |
| **MainLayout.svelte** | 1,706 | TitleBar (~150), ChannelView (~500), DMView (~400), CallOverlay (~300) | ~250 | TBD |
| **RightPanel.svelte** | 1,196 | ServerInfoPanel (~500), MemberListPanel (~500) | ~100 | TBD |
| **Login.svelte** | 1,132 | EmailAuthForm (~400), GuestAuthForm (~200), OAuthProviderGrid (~300) | ~100 | TBD |
| **UserPopout.svelte** | 1,101 | UserInfoCard (~400), RoleBadgeList (~100), UserActionMenu (~300) | ~150 | TBD |
| **CallView.svelte** | 1,079 | VideoParticipantGrid (~500), CallControlsBar (~300), ScreenShareView (~200) | ~100 | TBD |
| **WhiteboardCanvas.svelte** | 910 | ToolPanel (~300), DrawingLayer (~300), DataSync (~200) | ~100 | TBD |

---

## Extraction Pattern (Follow Exactly)

### 1. Create New File
```svelte
<!-- src/lib/components/settings/XxxSettingsTab.svelte -->
<script lang="ts">
	import { _ as t } from '$lib/i18n';
	import { currentUser } from '$lib/socket';
	// ... other imports

	// STATE — move from Settings.svelte
	let xxx = ...;

	// HANDLERS — move from Settings.svelte
	function handleXxx() { ... }
</script>

<div class="settings-section">
	<!-- markup from Settings.svelte -->
</div>
```

### 2. Wire Into Shell
Replace in Settings.svelte:
```svelte
{:else if activeSettingsTab === 'xxx'}
	<XxxSettingsTab />
```

### 3. Verify Build
```bash
cd /home/Ronin/wabi/frontend && bun run check
```

### 4. Commit
```bash
git add -A && git commit -m "decomp: extract XxxSettingsTab from Settings.svelte"
```

---

## Files Iyoku/Ironin Should Read Before Starting

1. `frontend/src/lib/components/settings/ProfileSettingsTab.svelte` — **THE TEMPLATE**
2. `frontend/src/lib/components/FRACTURE_PLAN.md` — roadmap with line ranges
3. `frontend/src/lib/components/Settings.svelte` — source file (line ranges in table above)
4. `frontend/src/styles/components/sidebar-core.css` — example of CSS extraction

---

## Rules

1. **Zero <style> blocks in extracted components** — all styles from global CSS files
2. **Import stores directly** — no prop-drilling for `$currentUser`, `$channels`, etc.
3. **Event dispatch for shell interactions** — `createEventDispatcher` for modal opens
4. **Move both markup AND script state** — extract `let`/`const` declarations + handlers
5. **Verify `bun run check` passes before claiming done**
6. **One component per commit** — no batching
7. **Don't touch protocol-generated files** (`wabi-protocol/src/generated/`)
8. **Don't touch Settings.svelte** — Hermes handles that
9. **Don't touch files with _existing extraction already done** (MessageItem, ServerSwitcherPanel)

## Verification

Run this after each extraction:
```bash
cd /home/Ronin/wabi/frontend
echo "=== File sizes ==="
wc -l src/lib/components/Settings.svelte src/lib/components/*.svelte | sort -hr | head -15
echo "=== Build check ==="
bun run check 2>&1 | tail -20
```