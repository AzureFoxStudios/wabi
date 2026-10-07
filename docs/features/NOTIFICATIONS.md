# Activity and notifications candidate

**Status:** working-tree candidate, not deployed or accepted on devices (2026-10-07).

## Experience

- **Activity** is a center-stage workspace, accessible from the workspace picker and mobile navigation. It has **Needs you**, **Following**, and **Friends** sections. Friends no longer occupies a Messages tab.
- **Needs you** shows incoming friend requests on the current server and signed-in saved servers, plus unread DM/group conversations and mentions found in channels already loaded on the current server. A row opens its source context; a request on another server switches there before opening Friends.
- **Following** shows activity for channels the client has followed on saved servers. Following defaults to **Silent**. A user can choose Mentions or All Posts for system alerts on an inactive server. The Activity row remains available when those alerts are disabled.
- **Friends** is server-local. Switching servers changes the friends directory; accepting a request does not grant channel access.
- Notification settings control system alerts, message previews and sounds, mention suppression, and inactive-server followed-channel alerts. System notification permission and push subscription remain separate platform controls.
- **Web Push** delivers background alerts to browsers and PWAs (RFC 8291/8292). Direct messages and incoming calls are on by default and can be turned off per-account. Payloads never contain message text. A per-account device cap bounds stored secrets.

## Data and trust boundaries

The client keeps one active server connection. Inactive saved servers are polled using that server's own saved credentials. Friend requests and followed-channel activity are fetched separately; no Authority shares identity or state with another Authority. The follow poll checks channel access for every request, caps channels and returned messages, and redacts spoiler and ciphertext content. The browser stores followed-channel cursor, count and channel metadata locally; message preview text stays in memory and is discarded on restart. The UI should not describe these previews as durable history.

The center only shows data that is actually available. It cannot recover missed live-only messages, derive unread mention state for unloaded channels, or collect DMs from an inactive server without further server support. Followed-channel polling requires an active client; it is not background push after the client exits.

## Remaining work before claiming a complete notification system

1. Add an Authority-owned per-account notification/read-state feed for mentions, DM messages, friend requests and urgent incidents. Define cursor, deduplication, retention, permission revocation and account switch behavior before aggregating it across saved servers.
2. Give priority and emergency events explicit authorization, rate limits and a distinct attention level. Emergency toast and sound must respect platform permission and user accessibility preferences; ordinary messages should remain quiet by default.
3. ~~Wire normal Web Push and native tray delivery to real server events.~~ **Done:** DMs and incoming calls dispatch to registered devices. Mentions and followed-channel activity are not yet wired.
4. Verify keyboard, screen reader, mobile and native tray behavior on real rendered clients. Confirm account-scoped local follow preferences and migration before using them as a durable multi-account notification source.
5. Wire UnifiedPush delivery for the Android APK (no Google dependency). The APK currently has local notifications only, which require the app process to be alive.
