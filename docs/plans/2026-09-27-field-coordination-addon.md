# Field coordination addon — proposal

**Status:** product and architecture proposal with an opt-in working-tree adult/test-account manual check-in pilot, 2026-09-27. No automatic GPS tracking, Reticulum intake, background emergency delivery, or child-safety deployment is established.

## Why this belongs in Wabi

A scouting group, trail team, rescue exercise, or field class could use Wabi to coordinate an outing: invite a roster, share a route and meeting points, collect check-ins, and see the last reported position of consenting participants. The group may have ordinary internet, a local Wabi host, Reticulum/RNode, Meshtastic, or only intermittent contact. Wabi should make the observations useful to the humans organizing the outing and identify which network delivered each one.

The useful promise is **“who last checked in, where was that report, and who is following up?”** It is not a live radar for people. A missing packet, weak radio signal, or silent phone does not prove where a participant is or that they are in danger. If an AI assistant is included, it can summarize the recorded facts and suggested contact sequence; alert conditions and displayed evidence must remain deterministic and inspectable.

This is a focused candidate for an **optional field coordination addon**. It should consume an authorized observation stream from the communications bridge and publish the outing view that Wabi's existing Maps addon can render. The Maps addon should not need to know the details of Reticulum, Meshtastic, GPS, or a particular radio. Wabi should be useful alongside existing clients such as Sideband, which already has telemetry and maps, by adding shared roster, route, check-in, and follow-up workflows rather than copying its client.

See the [local field trial](2026-09-27-local-field-communications-trial.md) for the mixed-phone no-WAN acceptance plan, the [alternative communications bridge](2026-09-27-alternative-communications-bridge.md) for later network integrations, and [Alternative communications transports](../COMMUNICATIONS_TRANSPORTS.md) for the wider research.

## One concrete outing flow

1. A leader starts a time-bounded field session in a Wabi community, chooses a route or area on a custom map, names the people responsible for check-ins, and sets expected check-in intervals appropriate to the devices and network.
2. Participants and their guardians, where applicable, see what will be shared, with whom, and for how long. Each participant or device is explicitly admitted to the session.
3. A consenting device sends a short position/check-in through Wabi IP, Sideband/Reticulum, or a later Meshtastic connector. A base gateway receives it and records its original observation time and receipt time separately.
4. Maps shows the **last reported** position with age, source, and accuracy. The field view separately shows last packet heard, last human acknowledgement, and the expected next check-in.
5. The leader receives a clearly worded alert when a fresh, sufficiently accurate position is outside the planned area, a participant sends a help request, or a check-in is overdue. The leader can acknowledge and record the next human action.
6. The session ends and its location access closes. Retention and deletion follow a short, published session policy; any export is an explicit operator action.

The group still needs an agreed human check-in and response procedure. The addon can help coordinate it, but cannot certify location or rescue readiness.

## Addon shape and existing Wabi seams

The field coordination addon should consume authorized check-in and position observations from the general communications bridge. Its own Wabi-native check-ins can enter the same field observation contract. The radio adapters belong to the communications bridge so messaging and dispatch can use them without enabling Maps.

```text
Sideband/LXMF ──────┐
Meshtastic radio ───┼─► communications bridge ─► authorized observations
Other radio systems ┘                                      │
Wabi native check-in ──────────────────────────────────────┤
                                                          ├─► Maps field overlay
                                                          ├─► check-in and alert view
                                                          └─► session export/deletion
```

- **Maps:** the bundled [Maps addon](../../core/addons/server-map/README.md) has custom-map, layer, POI, and center/right-panel UI. Its board tokens remain browser-local, while the opt-in field pilot adds a separate Authority-owned manual check-in and X/Y schematic view. The `/api/places` server route still returns an empty list and has no save/delete handlers. Existing custom-map uploads use a branding asset path served by URL, so private participant positions belong in the authenticated field view, never baked into that image. The OpenStreetMap view is an external embed. Image X/Y pins also need calibration before GPS latitude/longitude can be placed accurately.
- **Addon registration:** Wabi's bundled addons require explicit frontend loader and server inventory wiring. Runtime backend plugins are operator-trusted code, not a sandbox. Keep the field addon optional and inspectable.
- **Alerts:** Wabi has client notifications and a test push path, but normal priority/push delivery is not yet complete. An initial field view may show in-app alerts; background/phone alert claims require a separate real-device delivery milestone. Existing bot messages cannot bypass encrypted/pending room restrictions.
- **Incidents:** Wabi has channel-scoped incident records that can support a human follow-up workflow later. They do not currently contain field observation or gateway state.
- **Privacy:** the Maps addon already states that member/location presence is opt-in and approximate by default. Precise outing location needs an explicit session grant and narrow leader/guardian access. Wabi's [ecosystem direction](../architecture/WABI_ECOSYSTEM_DIRECTION.md#privacy-authorization-without-surveillance) sets a high bar for collecting human-behavior telemetry.

Field observations need an Authority-owned persistence path with readback and replay, plus a session roster checked independently of channel membership on every read and write. The record format must be versioned before it enters WabiDB's durable event log. A projection tombstone alone does not erase older location events or backup copies, so a real youth-group deployment requires a verified retention and erasure design. Until then, use adult/test identities and synthetic positions for the local prototype.

## Observation contract

An observation should carry at least:

| Field | Why it matters |
|---|---|
| Session ID and mapped participant/device ID | Prevents a radio identifier from silently becoming a Wabi account or joining another outing |
| Source protocol, source identity, and source event ID | Provenance, authentication, replay protection, and deduplication across gateways |
| Observed-at and received-at timestamps | Delayed radio delivery must not make an old GPS fix look current |
| Optional latitude, longitude, accuracy, and coordinate source | A check-in or packet can exist with no usable position; manually entered positions are labeled |
| Optional battery and physical-link measurements | Useful diagnostics when present; RSSI/SNR is not distance or proof of proximity |
| Gateway receipt, participant acknowledgement, and alert acknowledgement | Distinguishes packet arrival from a person confirming their status |
| Expiry and retention scope | Keeps temporary outing telemetry out of permanent chat history by default |

Mapped identities need explicit approval by the outing owner. A displayed position is a device claim with a source and accuracy estimate, not independently verified proof of a person's physical location.

## Alert meanings

| Alert | Required evidence | Wording |
|---|---|---|
| Help requested | Authenticated participant/device help action | “Help requested by [participant/device] at [time]” |
| Outside planned area | Fresh position, known accuracy, configured area, and margin for uncertainty | “Last reported position appears outside the planned area” |
| Check-in overdue | Session schedule plus no accepted check-in by its deadline | “Check-in overdue; last contact [time]” |
| Link or battery concern | Physical-link/battery data with source and age | “Link quality low” or “Battery last reported low” |

Do not infer “disappearing,” “lost,” or “out of radio range” from RSSI, hop count, or silence. Reticulum traffic can cross multiple links and media; Meshtastic's position and telemetry intervals vary with configuration and airtime. A stale position must stay visibly stale, even when another packet from the same device is newer.

## First integration and staged delivery

1. **No-radio lab:** use Sideband/Reticulum over local IP, with a local MQTT broker if Sideband's telemetry export is enabled. Confirm its field names, timestamps, identity mapping, and how the source expresses delivery and permission. The gateway must be able to reach the Wabi Authority. This evaluates the ecosystem without pretending LAN is a field radio test.
2. **Read-only map proof:** add a separate field observation overlay to Maps and feed it a small authorized Sideband sample. Show source, age, and accuracy. Prove a participant who is not admitted to the outing cannot read the feed. Do not write these observations into ordinary map tokens.
3. **Outing workflow:** add time-bounded roster/consent, route/area, check-in schedule, leader acknowledgement, and deterministic alerts. Keep the first mobile notification claim within channels actually exercised; normal Web Push remains a separate gap.
4. **Radio field trial:** add an RNode/LoRa path and evaluate airtime, device battery, delayed delivery, GPS quality, network partitions, and locally available map coverage with real devices in Thailand-compliant configurations. The trial decides the default check-in interval and alert timing. A field device that cannot reach the Wabi Authority may still report through Reticulum to the base gateway; Wabi's map then updates only when that gateway can ingest the report.
5. **Second protocol:** connect Meshtastic position/telemetry through its official client interface using the same observation contract. Later APRS or cave-radio work needs its own equipment/operator partner and concrete data interface.

The first milestone is a **shared last-known field map and check-in workflow**, not continuous tracking or automatic rescue dispatch.

## Source and deployment boundaries

- [Sideband](https://github.com/markqvist/Sideband/blob/main/README.md) documents opt-in telemetry and maps. Its [MQTT exporter](https://github.com/markqvist/Sideband/blob/main/sbapp/sideband/mqtt.py) publishes readable telemetry fields, including location components defined in [sense.py](https://github.com/markqvist/Sideband/blob/main/sbapp/sideband/sense.py). A Wabi broker/bridge can read those values; the resulting feed must not be labeled end-to-end encrypted. Sideband's licensing also favors protocol-level interoperation over copying its source into Wabi.
- [Reticulum's routing model](https://reticulum.network/manual/understanding.html) spans multiple hops and interface types. Physical signal quality may be unavailable, and network reachability is not a geographic distance measurement.
- [Meshtastic position settings](https://meshtastic.org/docs/configuration/radio/position/) include GPS, phone-provided, and fixed positions; [mesh behavior](https://meshtastic.org/docs/overview/mesh-algo/) and [telemetry settings](https://meshtastic.org/docs/configuration/module/telemetry/) affect update frequency. [The official Python client](https://python.meshtastic.org/) exposes position/node events for an adapter.
- [Android background location guidance](https://developer.android.com/develop/sensors-and-location/location/background) and [Apple Core Location](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background) require explicit permissions and lifecycle work if Wabi itself reports phone location. A browser-only proof cannot establish reliable background field updates.
