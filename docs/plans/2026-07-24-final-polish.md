# Wabi Final Polish Plan (2026-07-24)

## Blockers
- Deploy stuck: SSH to Tim blocked (SELinux + Tailscale SSH re-auth expired)

## Outstanding UX Cleanup

### 1. Notes Center
- Current: Notes opens in right panel, simple list
- Needed: Center/main view with more controls
- Option: Addon tunnel to external apps (obsidian-like) - out of scope without plan

### 2. Right Panel (Full Panel Overhaul, not just dock)
- Current: Dock updated but interior content/layout stale  
- Needed: Proper admin content, settings integration

### 3. Admin Tab
- Current: "Worthless" - needs revamp
- Needed: What admin functions actually matter? (banner/icon upload, user management, etc.)

### 4. Maps Empty State
- Current: Says "Ask a server admin to configure maps" even when user IS owner/admin
- Needed: If user has `canManagePlaces`, show configure CTA directly

### 5. Forums Channel
- Current: "New Thread" button wastes top-right space
- Needed: Replace with "+" icon next to thread count ("X threads")
- Bug: "all threads" has lowercase 'a' - should be "All Threads"
- Missing: Category button / category filtering

### 6. Wiki System
- Current: Broken category handling, duplicate breadcrumbs removed but filtering incomplete
- Needed: Full overhaul to match documentation websites (Wikipedia/Grokipedia style)
- Priority: Low-medium (stable but limited)

## Next Steps
1. Fix Maps owner/admin CTA (easy - check permission before suggesting to "ask admin")
2. Fix Forums thread button + category system
3. Address Admin tab content
4. Notes center view (needs design discussion first)
5. Deploy when SSH works

---
*Write to docs/plans/ and tag @opencode for execution*