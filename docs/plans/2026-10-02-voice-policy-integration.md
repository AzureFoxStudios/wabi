# Voice/media branch integration — October 2, 2026

The integration of `feat/media-voice-policy-selective` keeps the hardened
Authority admission, current credential retention, durable restriction reads,
receiver consent, and channel publication fences. The branch's older signaling
facade and cached-identity moderation implementation are superseded by those
paths. Its history remains a merge parent.

The client LiveKit subscription selection, reconnect/watchdog behavior, video
sink behavior and restricted direct-P2P fallback are retained. Voice settings
now load through authenticated Authority policy routes. Channel selection and
policy hydration remain scoped by server, account and explicit session
generation; a delayed policy response cannot update a replacement account.

Voice policies live in `voice_policies.json`, separate from postcard channel
records. Invalid/unreadable stored policies fail closed on load. Failed
publication leaves the previous cached policy intact. Current registered admins
change policy under the membership writer and retained credential in the owned
operation. Policy changes apply to subsequent admissions; they do not claim to
revoke already issued media grants immediately. Bitrate and force-solo values
remain client settings, not new server transport guarantees.

Capacity counts unique accounts under the roster lock, so an existing account's
second device does not consume another slot. Entry modes are open, initially
self-muted, or policy-listener. Policy-listeners cannot use focus or
`all-listening` to gain publication. Ordinary secondary listeners can retain
explicit microphone-only `all-listening`. Self-state composes with durable
moderation rather than clearing it. Durable server mute still blocks all media
publication and durable deafen still blocks all receive admission; this merge
does not broaden those existing restrictions into microphone-only moderation.

The experimental broker requires an admitted live Socket.IO device and mints a
matching device identity. Delayed results recheck credentials, channel access,
restrictions and admission. Moderation queues matching updates for every
admitted device and the legacy `user:n` identity; corrupt durable restrictions
queue deny-all grants instead of reusing cached permissions. The helper retains
strict grant validation, bounded responses, and no credential redirects or
ambient proxy for its permission RPC.

The broker stays default-off behind `experimental-livekit-broker`. Permission
jobs are asynchronous, old self-hosted LiveKit tokens can reconnect, and no
immediate revocation or HA guarantee is added. Source-selective self-state
checks supplement the existing durable relay/recipient gates.

## Validation at merge preparation

- Pinned Rust core/code-generation tests: 166 passed, zero failed.
- Focused frontend admission/session/fallback/watchdog and stale hydration
  tests: 34 passed, zero failed.
- Media helper tests with local loopback RPC: 14 passed, zero failed.
- Frontend check found a pre-existing Thai translation mismatch; the integration
  owner is handling it. The imported fallback test's union narrowing was fixed.
- Focused server contracts are still pending the coordinated host build slot.
  The initial checks exposed a missing embedded frontend directory and a merge
  selection mistake; both were repaired. Test embedding uses the unchanged
  existing root frontend build through a read-only integration-worktree symlink.
  The final combined branch must rebuild its own static frontend before release.
- Real browser/media/SFU visual acceptance remains pending; unit/HTTP contracts
  do not establish actual camera, audio, video playback or provider revocation.

Pending server commands: `cargo test --locked -p wabi-server --features
addons,experimental-livekit-broker --test voice_restriction_contract --test
helper_resource_security_contract --test realtime_security_contract --test
channel_access_contract` and the library's `voice_policy`,
`voice_media_policy_tests`, and `media_permissions` tests. Also run the
helper-resource default-build broker-off test.
