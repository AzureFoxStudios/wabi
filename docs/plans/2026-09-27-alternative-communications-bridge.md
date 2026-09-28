# Alternative communications bridge for Wabi

**Status:** product and architecture proposal, 2026-09-27. No bridge, radio adapter, or offline Wabi mesh is implemented by this document.

## Goal

Let Wabi communities exchange useful information with people using independent communication networks when ordinary broadband or mobile service is unavailable. Start by interoperating with existing clients and protocols. A radio user should be able to send a short message from their existing app into a selected Wabi workspace and receive a reply, without installing Wabi or requiring a carrier at their end.

The first target is **Reticulum + LXMF**. Meshtastic is a second, distinct protocol adapter. Through-the-earth (TTE) systems enter through their actual text/data interface, an existing bridge, or a voice/dispatch operator. The [transport inventory](../COMMUNICATIONS_TRANSPORTS.md) covers other candidate media; the [field coordination addon proposal](2026-09-27-field-coordination-addon.md) is one consumer of this general bridge.

## What the person can do

1. An operator runs a Wabi Authority and an optional bridge beside it, potentially on a portable laptop or mini-PC with a local Wi-Fi network and no internet uplink. Wabi members near the hub use the normal Wabi client.
2. A remote participant uses an existing Sideband/LXMF client and a configured Reticulum path, potentially RNode radio. They send a short text or check-in addressed to the bridge's LXMF identity.
3. The bridge admits that message into one explicitly mapped Wabi room or gateway inbox, preserving its external identity, origin, timestamp, and delivery state. A Wabi member replies through the bridge. The remote participant receives a normal LXMF message in their existing client.
4. A Wabi map, incident log, or field roster may consume an authorized location/check-in observation from the same bridge. Those are optional workflows, not prerequisites for ordinary messaging.

This is a concrete alternative to *depending on a phone network or broadband for the remote exchange*. The packet path and its range come from Reticulum's configured interfaces and radios. The local hub can also function without any internet uplink. A mobile phone alone is not currently a Wabi Authority host, and Wabi's rich web app, files, realtime presence, and Opus calls are not assumed to fit through low-rate radio links.

```text
Sideband/LXMF client -- Reticulum over RNode/radio -- LXMF bridge
                                                        |
                                               local Wabi Authority
                                                        |
                                         Wabi room / dispatch / maps
```

## Three levels of integration

| Level | Scope | Maturity target |
|---|---|---|
| **Interoperability bridge** | Selected Wabi text/check-in events ↔ existing LXMF destinations and inbound messages. The external participant keeps their native client. | First implementation and field proof. |
| **Protocol adapters** | Add Meshtastic, then selected APRS/JS8Call/Winlink or specialist equipment through their documented local interfaces. Every adapter declares its actual capacity and receipt semantics. | After the common message and permission contract holds. |
| **Native Wabi over delay-tolerant radio** | A future Wabi client could send a compact, authenticated subset of Wabi actions toward an Authority. It needs its own client protocol, identity/admission model, custody queue, and Wabi state reconciliation. | Research only; no existing WabiDB replication or legacy mesh shortcut. |

When a gateway cannot reach its Authority, it may retain an outbound/inbound queue for later synchronization. A radio message in that queue is **not yet accepted Wabi content**. When two radio peers can communicate but no gateway can reach a Wabi Authority, their native network can still work independently; Wabi cannot claim a live room or receipt for that exchange.

## Proposed addon boundary

The **communications bridge** should be an optional operator-installed integration with a small Wabi-side admission API and one sidecar or adapter process per protocol. The Wabi Authority remains the sole owner of Wabi accounts, permissions, room state, and durable messages. An LXMF sidecar can use the official Reticulum/LXMF Python libraries and the operator's existing local Reticulum instance; Wabi need not implement a radio driver.

The operator chooses a bridge identity, one or more approved external destinations, the Wabi room or inbox, permitted directions, content classes, rate limits, expiry, and who may send from Wabi. There is no automatic export of a room. The bridge UI shows its gateway identity, configured transport, current connectivity, last successful exchange, queues, failures, and a small test-message flow.

Mapping both Reticulum and Meshtastic to a Wabi space must not silently relay one radio network onto the other. Cross-network forwarding needs its own explicit rule, visible provenance, loop protection, and policy check for both sides.

Wabi needs a scoped admission path that checks room access and bridge policy for inbound and outbound traffic, writes accepted messages durably, and exposes idempotent status updates. The existing bot-send and webhook paths are useful code references, but they are not a finished radio bridge: bot-send rejects encrypted/pending and Live rooms, and webhook delivery does not supply the durable queue and end-to-end receipt model needed here. Bundled addons also require explicit backend and frontend wiring. Do not claim a manifest alone installs this capability.

### Common event contract

The bridge should normalize only information the medium can honestly carry:

- stable event ID, external network and sender identity, gateway identity, destination, and source proof where available;
- event kind (`text`, `check-in`, `position`, `help`, `ack`, or `operator voice log`), compact payload, created/observed/received times, and expiry;
- message size and encoding limits, rate/airtime budget, retry policy, and optional hop limit;
- mapping and permission decision, content conversion, provenance label, and audit entry;
- distinct states for **Wabi accepted**, **queued at bridge**, **handed to network**, **recipient/device receipt where the protocol provides one**, and **human acknowledgement**.

Deduplicate across retries and gateways. An external callsign, LXMF destination, or radio node ID never silently becomes a Wabi account. The UI must show when a message is delayed or its delivery is unknown; network receipt is not proof that a person read it. Rich messages, attachments, reactions, live presence, and arbitrary Wabi state have no generic radio conversion. A compact link or summary needs an explicit policy and can be useless to an offline recipient.

The first bridge should use an explicitly server-readable Wabi destination whose members understand that selected content crosses to a separate network. It must not decrypt an encrypted conversation at the server, treat experimental encryption as an operator-blind guarantee, or publish private-room content by default. Radio rules vary by service and country; the transmitting operator selects compliant equipment, frequencies, content, and identification.

## Protocol roadmap

### 1. Reticulum/LXMF

Run a local LXMF adapter against a shared Reticulum instance. Prove bidirectional compact text with an unmodified Sideband client first over a lab interface, then over a real radio bearer with the WAN and carrier paths absent. Show actual LXMF delivery states rather than equating enqueue with receipt. Reticulum can span IP, serial, packet radio, and RNode/LoRa interfaces; the bridge should report the configured route it knows, not promise a particular distance.

**Acceptance:** an external user sends to the bridge identity; the authorized Wabi room or inbox shows a labeled inbound message once; a Wabi reply reaches the external user once; duplicate/replayed/expired messages are handled; disconnect/reconnect preserves queue status; the entire radio trial succeeds without broadband or mobile data between the endpoints.

### 2. Meshtastic

Use a dedicated, locally attached Meshtastic gateway radio through its supported client interface (serial, TCP, or BLE as appropriate to the host); a personal radio's connection may already be occupied by its normal app. Start with short text and explicit node/channel mapping. An internet MQTT gateway is optional, not the basis of the offline proof. Meshtastic and Reticulum/RNode use different over-the-air protocols; the same Wabi event contract does not make their radios interoperable with each other. Cave-focused Meshtastic firmware variants may also differ from stock packet formats and must be named in any field claim.

**Acceptance:** repeat the Wabi ↔ unmodified Meshtastic-client exchange with no internet route, then verify payload limits, retransmission/deduplication, and the meaning of any node acknowledgement.

### 3. Through-rock and underground systems

There are two different integration classes:

| Equipment path | Wabi role | Gate before promising an adapter |
|---|---|---|
| **Text/data TTE** such as Cave-Link, Nicola 4, or QDX-M/RadioMsg | Exchange short dispatch messages and check-ins through a documented local interface or a partner-maintained gateway. | Obtain the actual message API/protocol, equipment, operator partnership, and field proof. A user interface or serial connector alone does not establish a software API. |
| **Existing TTE ↔ mesh link** | Connect Wabi to the mesh-side gateway and preserve the cave-radio origin. | ECRA reports bidirectional Nicola 4 ↔ Meshtastic messages, but says cave testing of that combined link remains. Verify the actual bridge and its supported message fields. |
| **Analog voice/PTT TTE** such as HeyPhone | A human dispatcher logs calls, acknowledgements, and decisions in Wabi; a hardware audio/PTT gateway is possible only where the equipment and operating rules allow it. | Obtain an audio/PTT interface and an operator workflow. This is radio dispatch, not a fallback Wabi VoIP call. |
| **Wired cave data link** such as Dataphone | If it supplies reachable IP, run normal Wabi traffic to a local Authority or gateway. | Verify power, physical link, and server reachability; this is a wired cave network, not radio transmission through rock. |

The [2026 European Cave Rescue Association catalogue](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Catalogue-1.60.pdf) is the current equipment starting point. It reports Cave-Link text and optional surface SMS forwarding (which needs cellular service), Nicola 4 cave voice/text tests and a developing Meshtastic bridge, and QDX-M cave-variant text tests at about 600 m through rock under reported conditions. Those are specific projects with different interfaces, availability, and legal conditions. The [ECRA underground Meshtastic report](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Meshtastic-1.00.pdf) covers mesh relays along passages; that is not the same physical path as low-frequency through-earth radio.

### 4. Other radio and acoustic paths

APRS, JS8Call, and Winlink can each supply an operator-station connector for their own message shape, if the station and service rules permit it. Audible/near-ultrasonic sound exchange can bootstrap or move tiny nearby messages; it is distinct from low-frequency electromagnetic communication through rock. Satellite and commercial telecom adapters are separate provider integrations. Each enters only after its real local interface, payload budget, rules, and owner are known.

Open radio voice projects such as [M17](https://m17project.org/about/) and [FreeDV](https://freedv.org/) merit a distinct later audio/PTT gateway study. [Reticulum's LXST applications](https://reticulum.network/manual/software.html#voice-telephony) are another voice option on adequately fast links. The first LXMF text bridge and ordinary low-rate LoRa radio do not establish any of these as Wabi live-call transports.

## Product proof and honest status

The project should have an operator-visible compatibility page: **network, equipment/client tested, payloads, direction, offline proof, delivery meaning, and known limits**. Mark each adapter as proposed, lab interoperable, field demonstrated, or supported. A LAN-only LXMF demo proves protocol mapping; the no-WAN radio trial proves the alternative communications claim. Publishing a success story should credit the native network and client that carried it.

The field coordination addon and Maps can subscribe to authorized bridge observations for outings. General messaging, dispatch, and learning/setup surfaces must remain useful without Maps. Wabi becomes a practical front end and organizer for these networks by respecting their native clients, explaining their constraints, and making their messages actionable for a community.

The integration should be built in the open with the network communities: use their published protocols and clients, publish reproducible interoperability demos and adapter code, report discovered interface problems upstream, and document which equipment and firmware were actually used. An existing Reticulum, Meshtastic, or cave-radio user should gain a useful Wabi destination without being asked to adopt a Wabi-only radio format.

## References

- [Reticulum interface configuration](https://reticulum.network/manual/interfaces.html), [local instance sharing](https://reticulum.network/manual/using.html), and [LXMF router API](https://github.com/markqvist/LXMF#the-lxm-router).
- [Meshtastic Python client](https://python.meshtastic.org/) and [ECRA underground Meshtastic report](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Meshtastic-1.00.pdf).
- [ECRA underground communications catalogue](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Catalogue-1.60.pdf), [Cave-Link V2 user manual](https://expo.survex.com/expofiles/documents/hardware/Cavelink2.13_en_2014-3.pdf), and [BCRA HeyPhone documentation](https://bcra.org.uk/creg/heyphone/).
