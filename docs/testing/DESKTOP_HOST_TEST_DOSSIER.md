# Wabi Desktop Host Mode — Testing dossier

Patch: `HOST-TEST-20260917-A`. Base: `cc7d9173e4a002ad95ce663433a51da365dc4197`. Date: September 17, 2026.


## Wabi Desktop Host Mode

TESTING DOSSIER • 17 SEPTEMBER 2026

Launch Wabi. Host a community. Invite someone. Keep the same server when moving to a dedicated machine.

### Current decision: engineering handoff, not a test release

This dossier accompanies hardening patch HOST-TEST-20260917-A, originally prepared against cc7d9173e4a002ad95ce663433a51da365dc4197. The source changes and this Markdown dossier are committed together on codex/desktop-host-mode-20260916 in draft PR #233. They have not been merged or deployed. No runnable installer is supplied with this document.

The original downloadable handoff was prepared before publication. Authenticated GitHub write access was available for the subsequent publication, and all 24 local JavaScript tests were rerun successfully. The local environment still has no Cargo or Rust compiler; publication does not turn written code into a verified native release. The checked-in local validation record is in evidence/HOST-TEST-20260917-A/.

| Evidence at handoff | Result |
| --- | --- |
| Invitation parser tests | 6 passed locally |
| Existing packaging/registration checks | 8 passed locally |
| New package-evidence/configuration tests | 10 passed locally |
| JavaScript syntax and patch whitespace checks | Passed |
| New Rust guards and native changes | Written; not compiled or run |
| Full server, desktop and installer build | Required at the patched revision |
| Physical joining, calls and recovery | Not run |
| Automatic fresh-device private connection | Still incomplete; blocked, not ready for user testing |

### What you should prepare

Two existing Bazzite computers, a phone capable of a cellular-data hotspot, and headphones/microphones. Use disposable accounts and files. A Windows computer and a third participant are later coverage, not prerequisites or purchase requests.

### Do not start the hardware session yet

The maintainer must obtain green full-build gates at the committed revision and provide a matching Wabi Host Test package plus host-test-evidence.json. Passing helper tests is not that gate. The test package must identify itself as a separate installation so recovery work cannot target your regular Wabi data.


## Prepare once; keep the scope small

TESTER SETUP

| Device | Initial role | Later role |
| --- | --- | --- |
| A: Bazzite computer | Host and owner; home network | Restore/migration source |
| B: Bazzite computer | Ordinary member; same home network | Cellular-hotspot guest; then host |
| Phone | Not a Wabi client | Provide cellular internet to B |
| Optional Windows machine | Guest after Linux passes | Repeat hosting and recovery |

### Before installing

Receive one test installer and its evidence file for your operating system. Both computers should use the same recorded source revision. The expected label is Wabi Host Test; the application identifier is chat.wabi.hosttest, separate from chat.wabi.app. This separation still needs a real installation check; it is not permission to use valuable data.

Prefer a separate operating-system account or another clearly isolated test profile. Do not wipe a machine or uninstall your existing Wabi. Keep all established Wabi servers stopped while testing storage migration. Keep ordinary firewall protection enabled; record any prompt and grant only the narrow application/network permission needed for the chosen test.

### Create a repeatable sample community

Use owner_a and guest_b with unique throwaway passwords. Create channels called test-chat and test-voice. Send a message labelled BEFORE-BACKUP and upload a harmless text file and image. Record their names. No reused passwords, private conversations, real community backup, or personal screen content.

### Network arrangements

Round one: A and B on the same home network. Round two, only after the private-connection implementation is ready: A stays home, B uses the phone’s cellular hotspot. Disconnect B’s Ethernet/home Wi-Fi. The phone must use cellular data, not rebroadcast home Wi-Fi.

For fresh-invitation acceptance, do not let an existing WireGuard/Tailscale/Tailcat enrollment or another preconfigured tunnel connect the machines silently. Keep such configurations for a separate supported-network test. A new browser tab is not a fresh native device identity.

### Test-data protection

Snapshots include identity keys. Keep them private and encrypted when moved off the test machine. Never post a snapshot, full invitation, password or private key as a bug report. Do not delete lock files, disable certificate checks, or change router forwarding to make a test pass.


## Round 1 — one computer

LOCAL HOSTING • GATE BEFORE INVOLVING COMPUTER B

### T01 — Install and identify the build
Install/run the supplied package on A without Git, Rust, Node or Docker. Open Host. Record the displayed build revision, the test-installation notice, and the data-directory location. Check that your regular Wabi profile has not changed.
**Pass:** The app opens, the bundled server is available, and the isolated identity and source revision match the evidence file. Missing runtime libraries or a missing server binary are failures, not instructions to install developer tools.

### T02 — Create a community locally
Choose Start my community. Create owner_a, including the password confirmation, then Open my community. Do not enable the network listener before setup completes. Create the sample channels, message and files.
**Pass:** Setup leads to the same usable community. The owner is established before network sharing becomes available. A readiness indication alone does not count as successful owner setup.

### T03 — Close, reopen and quit
Close the window and reopen it from the tray. Then choose the explicit Quit action and relaunch. Record exactly what the tray and quit controls explain.
**Pass:** Closing the window preserves the intended hosting state. Quit stops the owned server. Relaunch retains accounts, channels, messages and uploads. Confusing or absent confirmation is a UX defect to record.

### T04 — Restart and sleep/wake
Restart A normally and reopen the application. Separately, put A to sleep and wake it. Do not test power loss by pulling the plug.
**Pass:** Existing data returns. Hosting does not falsely claim availability while asleep or off. Any required manual restart is clearly explained; automatic background hosting is not assumed implemented.

### T05 — Cancel disruptive actions
Open the confirmation for backup, restore or network sharing, then cancel. Try repeated clicks while an operation is busy.
**Pass:** Cancel makes no change. Operations do not create duplicate servers or overlapping restore jobs. Record any permanent Starting status or interface freeze.

Stop rule: if T01 or T02 fails, stop here and report it. Do not spend time arranging remote participants for an app that cannot initialize locally.


## Round 2 — another member on the LAN

TWO COMPUTERS • CONTROLLED DIAGNOSTIC, NOT YET EFFORTLESS INTERNET HOSTING

Use the packaged desktop clients on both computers. The current invitation form still asks for an address the guest can reach. For this diagnostic only, a maintainer may supply A’s LAN address and the port shown in A’s local address. Replace 127.0.0.1 with A’s LAN address; keep the port. Do not send localhost to B. Record this assistance as an onboarding limitation.

The current LAN listener uses HTTP. Use only a trusted test network and disposable credentials; this is not internet-safe HTTPS. A plain HTTP LAN browser page is not a valid microphone/camera acceptance environment. Do not bypass browser or certificate security.

### T06 — Create and redeem an invitation
Finish owner setup on A. Enable LAN / reverse-proxy listener, confirm, and enter the reachable test address. Create a one-use invitation. On B, paste it into Join and create guest_b.
**Pass:** B reaches A, registers once, and sees the intended community. B gets ordinary-member permissions, not ownership. Joining on B does not start its own server.

### T07 — Reject invitation reuse
Try the same invitation with another new account. Preserve the original member account and confirm it can still sign in normally.
**Pass:** The used token cannot admit a second new member. Rejecting reuse must not delete the legitimate member or their messages.

### T08 — Exchange content and reconnect
Send labelled messages in both directions, upload the sample files, disconnect B’s network, reconnect and sign in again if asked.
**Pass:** Both sides see the same content and usable uploads. No missing history, duplicate post, wrong server/account or permanently stuck reconnect state.

### T09 — Owner and member permissions
From B, attempt an owner-only setting or invitation-management action exposed by the client. Do not use owner_a’s token or password on B.
**Pass:** The server refuses unauthorized actions. Hiding a button alone is not complete permission proof; automated API checks remain an engineering gate.

### T10 — Reverse the roles
Stop A’s hosted community. Use a different disposable community on B and join from A.
**Pass:** Both Bazzite machines can host and join. A successful guest-only test does not certify hosting on that machine.


## Calls and the eventual remote invitation

MEDIA IS A SEPARATE GATE FROM CHAT

### T11 — Two-way microphone audio
Return to the test community with A hosting. Join a voice channel on both devices using headphones. Speak separately on A and B; test mute, unmute and deafen, then select another available input device.
**Pass:** A hears B and B hears A. Mute and deafen affect the intended direction. Device changes recover without leaving a silent but apparently connected call.

### T12 — Screen sharing and permissions
Share a harmless application window, then a whole test screen where supported. Stop sharing and restart it. Cancel/deny a capture or microphone permission once, then follow the operating system’s normal permission controls.
**Pass:** The receiver sees the intended live content; stopping really stops it. Permission refusal produces useful feedback. Distinguish microphone audio, system audio, video and screen capture in the report.

### T13 — Call recovery
While in a call, interrupt B’s network briefly, restore it, and repeat after normal host restart and sleep/wake. Record which side loses sound or picture.
**Pass:** Chat and media recover independently and correctly. A working message does not excuse a frozen stream or a silent connection.

### T14 — fresh off-LAN invitation: BLOCKED

Do not run this as an acceptance test until automatic first-contact enrollment is implemented. The current patch does not create that connection. When ready, use A at home and a genuinely unenrolled B on cellular internet. Give B only the invitation and normal app instructions: no manual tunnel, port forwarding, prior server session or administrator credential.

Pass requires a fresh participant to connect, register, message, call, disconnect and reconnect. Record the observed route—direct or relay—rather than guessing. A working cellular test is one network sample, not universal NAT certification.

### T15 — expiry and revocation

Engineering must first provide a tested revoke path. Reject an unused expired invitation and an unused revoked invitation. Separately remove an admitted member/device and check access rejection, including an existing connection. Invite revocation alone does not necessarily remove someone already admitted. Do not change the computer clock to force expiry.

### Later group coverage

After two-device tests pass, add a third participant for group audio, overlapping screen shares and host bandwidth pressure. Repeat on Windows as both host and guest. This is not an initial hardware purchase or setup requirement.


## Recovery without risking your real community

DISPOSABLE DATA ONLY • STOP ON UNCERTAINTY

### T16 — Backup, change, restore
With BEFORE-BACKUP present, use Take a stopped backup and confirm. Wait for completion. Send AFTER-BACKUP and upload another harmless file. Select the earlier snapshot, restore and confirm.
**Pass:** The app actually pauses/stops for the snapshot, then resumes as documented. After restore, the earlier state and keys work; later durable content is absent. The pre-restore directory remains available for recovery. Check state, not merely a success toast.

### T17 — Reject a damaged snapshot
Maintainer-supervised: work on a duplicate snapshot, never the sole good copy. Change one harmless file in the duplicate and try restoring it.
**Pass:** Hash validation rejects the duplicate before changing active community data. The original snapshot and active community remain intact.

### T18 — Move the community to another computer
Use a complete stopped copy prepared by the maintainer. Keep A’s original community stopped. Restore/import on B using the documented path, then sign in with the original accounts and open sample uploads.
**Pass:** The same community identity, accounts, messages, uploads and invitation-use history are retained. A new blank community is a failure. Do not independently start both copies against shared storage.

### T19 — Uninstall / reinstall behaviour
Only with the isolated test package and a separate good backup, inspect uninstall prompts. Follow the documented retention choice; reinstall.
**Pass:** The app explains what happens to data. Any retained community reopens correctly. Nothing in your normal Wabi installation or outside the test profile is deleted.

### Engineering-only failure injection

Missing root key, missing storage manifest, full disk, permission denial, interrupted rename, incompatible storage versions and an independently running CLI writer are not beginner tasks. Run them against disposable copies with a recovery plan. The new guard tests and real-binary rehearsal cover refusal for missing identity/manifest; they still require compilation and execution.

### Do not “repair” by erasing evidence

Do not delete a live/stale-looking lock, regenerate a key, edit the database, or repeatedly run restore after an unexplained failure. Preserve the failed copy and logs privately. A stopped snapshot on the same disk does not protect against losing that disk.


## Engineering handoff and package gate

MAINTAINER APPENDIX • NOT INSTRUCTIONS FOR ORDINARY TESTERS

### What the supplied patch changes

A new bootstrap guard rejects an incomplete existing database before key generation. An explicit operator-provided root key remains supported; missing storage manifests with existing storage are rejected. Bounded native readers enforce limits while consuming chunked HTTP bodies and startup output. A concurrency regression now permits either request to become the first owner.

The independent Rust safety harness imports the production guards. The real-Authority rehearsal deletes identity/manifest files only in disposable stopped copies and expects refusal. The isolated Tauri flavor adds Wabi Host Test identity, build-revision display and Linux media bundling. The evidence tool hashes distinct server, desktop and installer files, checks OS/CPU headers, and labels physical acceptance as not run.

### Use the committed source without overwriting unrelated work

Use a clean checkout of the current codex/desktop-host-mode-20260916 branch from draft PR #233. Preserve unrelated working-tree changes before updating it. These changes are already committed; do not reapply the original handoff patch to the updated branch. The original Python apply helper is for an untouched cc7d917 baseline only and deliberately refuses a newer revision.

### Required commands and CI steps

```sh
node --experimental-strip-types --test scripts/tests/desktop-host-invites.test.mjs
node --test scripts/tests/desktop-host-foundation.test.mjs scripts/tests/desktop-host-evidence.test.mjs
cargo test --locked --manifest-path scripts/host-safety/Cargo.toml
cargo test --locked -p wabi-server
```
The updated integration workflow also validates/builds the frontend, runs real server startup/account/restore rehearsals, compiles native hosting, and only then builds a release Authority and isolated AppImage/NSIS package. It uses the locked frontend Tauri CLI, existing pinned Tailcat fetcher, and the hosting plus hosttest overlays. It does not publish a release or deploy anything.

Keep static server assets and native client assets in their correct build stages. Do not substitute an old server binary, ignore a failing suite, or label a raw desktop executable as the hosting installer. New workflow code has been parsed locally, not executed here.

### Evidence to hand the tester

Provide the platform installer, host-test-evidence.json, exact source revision and a completed engineering gate result. Hashes identify files; they are not code signatures or proof of compatibility. Record any signing/trust prompts for test builds rather than instructing users to disable platform protection.


## Record results and make the release decision

REPORT SHEET • REFERENCES • OPEN WORK

| Test record | Fill in |
| --- | --- |
| Test ID / date / time |  |
| Displayed source revision / package filename |  |
| A: OS version / desktop session / CPU / GPU |  |
| B: OS version / desktop session / CPU / GPU |  |
| Network: LAN / cellular / identified relay |  |
| Steps and expected result |  |
| Actual result and relevant error |  |
| Result: PASS / FAIL / BLOCKED / NOT RUN |  |

Attach a narrowly cropped screenshot or a short relevant error excerpt. For sound, say “A hears B; B cannot hear A.” For video, say “picture freezes after reconnecting.” Record whether the problem reproduces. Redact invitation fragments, account tokens, private keys and unrelated desktop content.

### Decision rules

Advance one round at a time. Mark missing features BLOCKED, not passed and not “the tester failed.” Stop on data loss, unexplained identity replacement, unauthorized access, another application being terminated, or tests reaching the ordinary Wabi profile. No public-ready claim until supported native packages, fresh remote enrollment, physical media and complete recovery all pass at the same revision.

### Work still required beyond this patch

Full Rust/server/native build failures still need verified resolution; these local edits do not certify them fixed. Automatic private first-contact enrollment remains implementation work. Full native restore transactions, independent-writer conflicts, compatible updates and optional background service behaviour remain open gates. Real-device testing cannot fill those coding gaps.

### References and version discipline

Repository: AzureFoxStudios/wabi, draft PR #233, branch codex/desktop-host-mode-20260916. Original patch baseline: cc7d917. Consult docs/plans/2026-09-16-desktop-host-mode.md, docs/deployment/DESKTOP_HOST_FOUNDATION.md, docs/NETWORKING.md and docs/PROJECT_STATUS.md. Patch identifier: HOST-TEST-20260917-A. The original downloadable ZIP and DOCX are authoring-time snapshots; their not-pushed status predates this publication. This checked-in Markdown dossier is the updated repository copy.

Primary build references checked for this work: https://v2.tauri.app/reference/cli/ and https://v2.tauri.app/distribute/appimage/. AppImage compatibility and media plugins require real platform verification; the bundling flag is not a screenshare guarantee.

This document intentionally supplies no password, private connection code, production backup or implied evidence of a test that has not run.
