# Local field communications trial

**Status:** working-tree local pilot and physical-test plan, 2026-09-27. The
invitation QR and opt-in adult/test-account Maps field board are in the current
Wabi source checkout. They have not been packaged, released, or deployed as part
of this work, and they will not appear in an existing installed Wabi. A build
from this checkout shows the field board only when its Authority starts with
`WABI_FIELD_PILOT=1`. Wabi's desktop-host candidate can serve a local
Authority. This document does not claim automatic GPS tracking, phone-to-phone
mesh, or reliable emergency alerts.

## Goal and available kit

Prove a Wabi group can coordinate on **one laptop/PC and mixed Android/iPhone clients with the internet disconnected**. Members join a local Authority, exchange messages, send deliberate check-ins, and see the last reported status and position on an authorized, locally available map. Start with adult volunteers or test accounts and synthetic positions. A youth-group deployment needs session-specific access, consent, retention, and physical reliability evidence before showing actual participant locations.

This is the near-term Wabi communications project. The [alternative communications bridge](2026-09-27-alternative-communications-bridge.md) and [deferred network research](2026-09-27-alternative-comms-return-catalog.md) keep Reticulum, Meshtastic, through-earth, and other radio work ready for later.

## What exists and what must be built

| Capability | Current Wabi state | Trial gate |
|---|---|---|
| Laptop-hosted Authority | Desktop Host Mode is a working-tree candidate with local owner setup, explicit LAN sharing, local IPv4 selection, and one-use invitations. Mobile is client-only. Native runtime evidence is presently Linux-focused; Windows/macOS hosting still needs platform acceptance. | Run a build supported on the actual laptop and connect both phone types over the chosen no-WAN Wi-Fi. Do not count loopback/browser simulation as a phone trial. |
| Short local messages | Normal Wabi client/Authority traffic can use a reachable LAN. Account-scoped outbound queueing can replay some work after reconnect to the same Authority. | Send in both directions, disconnect each phone, reconnect, check identity/message reconciliation and visible delay. No message or alert reaches an out-of-range phone in real time. |
| QR/NFC join | Host issues a one-use URL. A dynamic host-invitation QR has been added to the working-tree host screen, clears at expiry, and passed a rendered browser smoke; it has not been scanned on a physical phone. No Web NFC or phone-to-phone NFC handoff exists. | Scan a fresh invitation with the phone's system camera. An optional NFC tag can open the same URL if rewritten for that one invitation; a static public tag must contain no reusable admission secret. |
| Shared field map | The opt-in working-tree field pilot keeps each consenting participant's latest manual check-in and latest X/Y pin in an Authority-owned sidecar, displayed on an offline schematic inside Maps. It is separate from browser-local board tokens; `/api/places` still returns an empty list and the OSM iframe needs internet. Existing image uploads are served by URL. | Run two-device read/write/revocation trials on the actual laptop and phones. Use only non-sensitive local map art. Do not treat board tokens or branding uploads as private person-location storage. |
| Phone position | A one-shot directions GPS helper exists only for the requesting device. The host's LAN address is plain HTTP; phone-browser geolocation, camera scanning, service workers, and other secure-context features cannot be assumed there. | Manual map pin/check-in first. For GPS, prove trusted local HTTPS or a supported native client on both platforms, then test explicit one-shot permission and accuracy. |
| Alerts | The opt-in pilot has an in-app help request and leader acknowledgement; ordinary background priority/push dispatch is not established. | Test help/acknowledgement while every client is foregrounded and connected. Test background delivery separately before claiming emergency notification. |

The [project status](../PROJECT_STATUS.md) and [desktop hosting guide](../deployment/DESKTOP_HOSTING.md) remain the maturity sources for the host candidate. Map-specific findings are in the [field coordination addon proposal](2026-09-27-field-coordination-addon.md).

## Enable the working-tree pilot

The field board is **off by default**. An operator starts the Authority with `WABI_FIELD_PILOT=1`; only then does the Maps center-stage screen offer **Field pilot**. The desktop-host candidate clears other inherited deployment variables, but explicitly forwards this one boolean when the desktop app itself is launched with it. For a local Linux development build, the shape is `WABI_FIELD_PILOT=1 /absolute/path/to/wabi-desktop`; a packaged build needs its actual executable path. A standalone Authority can be started with the same flag. Turning the flag off on the next Authority start removes the field API; it does not erase an earlier sidecar or backup.

Only an owner/admin starts an outing, inviting existing registered accounts. Each invited person consents before reading the shared board or sending a check-in. Consenting members can see the other consenting members' reports; invitees who have not consented are hidden from them. Participants may leave, the leader can revoke access or end the outing, and the current session record is removed on end. The working-tree pilot allows one active session per leader, up to four on a server, and up to 128 accepted reports per participant in a session. Its data is server-readable plaintext on disk and in backups; LAN sharing uses plain HTTP. Use adult/test accounts and synthetic positions until the privacy and transport gates below pass.

## Local network variants to test

1. **Baseline: existing router with WAN unplugged.** Connect laptop, one Android phone, and one iPhone to the same Wi-Fi. Disable phone cellular data for the trial as well. Start the Authority on the laptop, opt in to LAN sharing, and issue a separate invitation for each phone. This isolates Wabi behavior from hotspot behavior.
2. **Android local-only hotspot.** On a supported Android device, create a local-only Wi-Fi network without internet using the platform feature; join the laptop and second phone, then repeat the same Wabi flow. Wabi does not currently start this network itself, and the OS may reject it based on capability or permission. Record the actual device/OS and whether the hotspot phone can itself run Wabi as a client during the trial. [Android's LocalOnlyHotspot API](https://developer.android.com/develop/connectivity/wifi/localonlyhotspot) is the platform basis.
3. **Laptop hotspot or travel router.** If the laptop OS offers a reliable no-WAN access point, or a small travel router is available, repeat on that network. This may be the simplest cross-platform field kit because the laptop already runs the Authority.
4. **iPhone Personal Hotspot:** treat it as a cellular-sharing feature, not the no-service foundation. [Apple's description](https://support.apple.com/en-us/111785) ties it to the phone's cellular data connection. Future [Wi-Fi Aware on supported Apple devices](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview) is a separate native-app research path.

A hotspot creates the link; the laptop still supplies Wabi's Authority. No step in this trial depends on a public Meshtastic node or a stranger's radio network.

## Joining by scan or tap

The host should show a QR for each *newly issued, one-use* invitation and display its expiry. The phone's **system camera** opens the URL; this does not need an in-app camera permission. The invite is carried in a URL fragment to keep it out of the HTTP request, but anyone who sees or photographs the QR before use can redeem it. Clear the displayed QR when the invitation is cleared, redeemed, revoked, or expired.

NFC is a second way to open the same URL, not an independent network. A rewritable physical tag may hold a single current invitation for a deliberate tap test. A permanent tag should point to a nonsecret local join/help page where the host can issue a fresh invite. [NFC Connection Handover](https://nfc-forum.org/build/specifications/connection-handover-technical-specification/) is a bootstrap concept; it does not mean arbitrary mixed-phone peer-to-peer NFC transfer is available in Wabi. Android's [Web NFC support](https://developer.chrome.com/docs/capabilities/nfc) is for NDEF tags, and this trial does not depend on browser NFC support.

## Field observation model to implement

Use a distinct optional field-coordination addon or equivalent scoped module. Radio protocol code belongs in the future communications bridge, while this module owns the outing roster and map. A field observation must include:

- an outing/session ID and mapped participant/device identity approved for this outing;
- kind: `okay`, `help`, `manual position`, or later `device position`;
- **observed at** and **Authority received at** times, location source and accuracy when available;
- source event ID for retries and deduplication, expiry, and retention policy;
- Authority receipt, leader acknowledgement, and next human action as separate states.

Server-side admission must check outing membership and viewing role on every read/write. Ordinary channel membership is too broad for precise participant locations. End the session by stopping intake and access; provide deletion/export semantics before use with real youth-group data. A position is **last reported**, with age and source visible. Silence or signal loss is an overdue check-in, not proof a person is lost or outside range.

The storage choice is part of that privacy gate. WabiDB is event-sourced: removing a current-view row or writing a tombstone does not, by itself, erase older coordinates from committed events or backups. Before collecting real participant locations, define and verify a retention and erasure path for the underlying records and copied backups. Keep an adult/test-account manual-pin pilot separate from that release claim.

For the first offline map, use locally available, non-sensitive custom art or a simple calibrated area diagram, then place **manual normalized X/Y pins**. The current custom-image viewport has no lat/lon-to-image transform, so device GPS cannot be plotted correctly on it until control points/calibration exist. The existing remote OpenStreetMap iframe cannot be the offline map. Do not bake a child's position, roster, or route into the publicly served branding image; keep those in the authorized overlay.

## Build slices and acceptance

| Slice | Build | Evidence required |
|---|---|---|
| **A. Join the local hub** | Dynamic QR for existing one-use invitation; network/reachability guidance. | Android and iPhone each redeem a different invite with WAN unplugged; reuse/revoked/expired invites fail; host can see whether the phone reached the Authority. |
| **B. Deliberate check-in** | Working-tree pilot: session roster, consent, `I'm okay` and `Need help`, server-side latest report, read permissions, and separate leader acknowledgement. | Two devices submit; unauthorized account cannot read or forge; a duplicate retry yields one observation; an unacknowledged help remains visible after a later routine report. |
| **C. Shared last-reported map** | Working-tree pilot: private manual X/Y observation on an offline schematic, with source and age. A custom image needs generic public art; there is no georeferencing yet. | Host and both phones see the same approved data; stale pins remain visibly stale; session revocation blocks subsequent reads. |
| **D. Device location** | Trusted HTTPS or validated native location path, per-action permission, map calibration or local offline tiles. | Both phone platforms report a one-shot fix with source/accuracy; refusal and missing secure context give a usable manual fallback. No background-tracking claim. |
| **E. Field drill** | In-app overdue/help workflow and clear network state. | Repeat with phones moving out of Wi-Fi range and returning, battery/screen lock, server restart, and no WAN. Record missed, late, duplicate, and unacknowledged reports. |

The **first physical trial** can exercise A, ordinary chat, and the opt-in manual B/C pilot once a current desktop-host build is installed on the laptop. The invitation QR has rendered in a browser smoke, but neither phone has scanned it yet, and no mixed-phone field session has been verified. D requires a secure location path. Do not call the system rescue-grade, military-grade, or dependable child safety infrastructure until those gates and repeated real-device drills are met.

Preparatory software checks on this working tree: the desktop-host browser smoke passed 14 scenarios including invitation expiry; the field UI rendered browser smoke passed five scenarios at desktop and phone widths with a **synthetic** Authority; field UI helpers passed two focused cases; the field Authority passed six unit checks and one route-level consent/access/expiry contract; Maps coordinate/layer normalization passed three focused cases; and the frontend type/Svelte check reported zero errors (114 existing warnings). The desktop source compiled with its unavailable local Tailcat bundle asset omitted from the check configuration; that does not validate an installer or native field run. The Maps data fix preserves geographic latitude/longitude and object-valued layers/points of interest through client serialization; `/api/places` remains without shared place persistence. None of these checks establishes phone join, hotspot, NFC, GPS, or field-alert behavior on physical devices.

## Evidence sheet for each run

Record the laptop OS and Wabi build, phone models/OS/browser or native app, network variant, LAN address, WAN/cellular state, invitation expiry, join result, message/check-in times, server receipt, human acknowledgement, map freshness, disconnection duration, and recovery outcome. Save only test-account/synthetic coordinates in the development evidence. Keep errors and screenshots that demonstrate the actual phone UI; a code or browser simulation result is a separate line of evidence.

## Platform references

- [W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/) and [Geolocation API](https://www.w3.org/TR/geolocation/) explain why a private `http://192.168.x.x` URL does not grant browser GPS and why explicit permission is required.
- [Android local-only hotspot](https://developer.android.com/develop/connectivity/wifi/localonlyhotspot), [Android Wi-Fi Aware](https://developer.android.com/develop/connectivity/wifi/wifi-aware), and [Apple Wi-Fi Aware](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview) are distinct local-network APIs with device and native-app gates.
