# Mobile shell IA (Wabi)

Locked product shape 2026-08-08. Full mobile skill: `wabi-mobile`.

## Bottom nav (MainLayout)

Max **four** destinations on phone:

| Tab | Behavior |
|---|---|
| Chat | Close sheets; channel stage (`activeView` chat) |
| Browse | `showMobileChannels` full-height sheet |
| Messages | `activeView = 'dm'` → DmHub; Notes under Messages/DM Hub |
| You | Settings |

Not a permanent Users tab as third peer to Chat/Channels — members stay context, not primary IA.

## Back behavior

`popstate` / Android back: Settings → Browse sheet → right overlay → leave DM → then exit.

## Softlock

Workspace full views still use shared `WorkspaceViewBar` return-to-Messages rule (see main SKILL).

## PWA / APK

Install banner + Web Push + Tauri Android ordering live in `wabi-mobile`, not here.
