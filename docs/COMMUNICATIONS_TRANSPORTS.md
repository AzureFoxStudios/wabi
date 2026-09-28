# Alternative communications transports

**Status:** research inventory and product exploration, updated 2026-09-27. This is not an implementation commitment or an operator guide.

The concrete, general integration proposal is the [alternative communications bridge](plans/2026-09-27-alternative-communications-bridge.md). The [local field trial](plans/2026-09-27-local-field-communications-trial.md) is the near-term mixed-phone/hotspot work, with an opt-in working-tree manual check-in pilot; the [field coordination addon](plans/2026-09-27-field-coordination-addon.md) remains the wider shared check-in and map design. The [return catalog](plans/2026-09-27-alternative-comms-return-catalog.md) preserves detailed radio and specialist-network research for later.

## Purpose

Wabi already works over ordinary IP networks. A client and Authority on the same router use the LAN; that is useful, but it is not a new transport, an offline phone-to-phone mesh, or radio interoperability. Wabi also has browser voice/video calling and optional relay/TURN/SFU paths. Those carry calls, not messages over independent radio systems.

This document maps other communication bearers Wabi might connect to. It distinguishes:

- **Bearer:** the physical or network path carrying data (Wi-Fi, BLE, LoRa, HF radio, sound, satellite, phone network).
- **Network/protocol:** how endpoints discover, route, retry, and address packets over one or more bearers (for example, Meshtastic, APRS, Reticulum, SIP).
- **Wabi integration:** an adapter or gateway that presents a transport to an explicitly authorized Wabi workspace.

“Mesh” is not one technology. A set of radios may provide mesh routing, a set of devices may carry messages opportunistically, or separate networks may be connected by a gateway. Those have different reliability and trust boundaries.

## Product direction: Wabi as a tool across networks

The aim is not to make Wabi invent another radio network or replace the clients people already use. Wabi should help small groups **use, coordinate, and learn about the open communication networks they choose**. The transport remains real and independently operable; Wabi contributes a familiar collaborative workspace and an optional, accountable bridge into it.

Reticulum is the strongest first ecosystem to explore. It is more accurate to describe it as an open networking stack for building and interconnecting independent networks over different media than as “long-range internet.” Depending on configured interfaces and reachable peers, those media can include local Wi-Fi/Ethernet, LoRa/RNode, packet radio, and IP links. Range comes from the actual link and network topology; Reticulum does not make a radio link long-range by itself. Its LXMF messaging layer already interoperates across Reticulum applications, including Sideband, Nomad Network, and other clients. Wabi should join that ecosystem through its established protocols rather than invent a Wabi-only radio mode.

This direction has two audiences:

- **People using community networks:** give them a welcoming workspace for coordinated conversations and shared work, while making it clear which messages can reach Reticulum peers and which stay inside Wabi.
- **People building and operating the networks:** make it easier to explain a network, find local setup guidance, track which links/gateways are active, organize experiments, and coordinate a volunteer group. Setup and status help can create value even before a community enables message bridging.

Do not describe Wabi as replacing the Internet, creating worldwide coverage, or making any radio transmission private, guaranteed, or lawful in every context. The claim should be that Wabi can work alongside a chosen network and help people make practical use of it.

## Current Wabi boundary

- The normal Wabi shape is one Authority owning community identity, permissions, and durable state. Clients may switch between independent Authorities; they do not federate.
- Voice, video, and screensharing use Wabi's existing browser calling stack and optional media helpers. Physical-device/network acceptance is still a project-status item.
- The working-tree Service Access feature is an authenticated TCP gateway for explicitly registered services. It does not provide UDP, arbitrary network routing, SMS, SIP, or radio bridging.
- WabiDB replication and warm standby remain experimental. Do not use them as the foundation for phone-to-phone message sync or describe them as mesh/failover.

See [Networking Model](NETWORKING.md), [Calling Transport Architecture](architecture/CALLING_TRANSPORT_ARCHITECTURE.md), [Service Access](features/SERVICE_ACCESS.md), and [Project Status](PROJECT_STATUS.md).

## Transport inventory

### Local access is more than “same router”

The LAN is an existing bearer, but Wabi can still make local use feel intentional and useful. These are separate product shapes:

1. **Same-network Wabi discovery:** find a Wabi Authority already reachable on the current LAN, then let a person join via an explicit invite/QR/code. This improves setup and local discovery; it does not create offline routing.
2. **Temporary offline Wi-Fi network:** create a local-only network for a gathering, field team, workshop, or outage. Android exposes a LocalOnlyHotspot API specifically for applications whose devices need to communicate without Internet access. Apple's Personal Hotspot is documented as sharing mobile data, so Wabi cannot assume an iPhone provides an equivalent internet-free hotspot. In every case, a Wabi Authority must also be running and reachable; a hotspot alone only supplies the link.
3. **One-tap/bootstrap handshake:** use an NFC tap (where platform APIs and hardware support it) or QR code to exchange a short-lived invite, endpoint, or public-key fingerprint, then switch to Wi-Fi or Bluetooth for actual communication. NFC can coordinate another wireless carrier through Connection Handover; NFC itself is only the very short-range bootstrap. An NFC tag at an event is a simpler cross-platform invite path than assuming two phones can exchange arbitrary app data by touching.
4. **Nearby Wabi discovery:** opt-in devices advertise a short-lived presence and invite each other to interact. Discovery can use BLE; the actual exchange can use a direct Wi-Fi path or BLE for tiny payloads. Scanning nearby is a discovery feature, not proof a Wabi Authority is present and not a multi-hop mesh.
5. **Device-to-device store-and-forward:** devices carry a small, expiring, signed message envelope and hand it along later when peers meet. This is the beginning of a true opportunistic mesh and needs custody/receipt, deduplication, hop limits, expiry, abuse controls, and a clear authority for accepting the message. It is not provided by ordinary LAN or hotspot connectivity.

These steps form a sensible progression: **discover a reachable Wabi → bootstrap a trusted local session → make a temporary local Wabi easy to join → direct nearby exchange → multi-hop custody mesh**. The first three can already be valuable to local groups without being described as radio mesh. Nearby discovery should be opt-in, use rotating identifiers, reveal no room/message content before consent, and include a manual QR/code fallback when background discovery is unavailable.

### Product ownership: Wabi should orchestrate local setup

The intended product is **Wabi-led setup with explicit OS consent**, not a guide that asks ordinary members to create a hotspot, find an IP address, and configure each device by hand. Wabi should select a supported local path, explain what it will do, request the platform permission, create/show a short-lived invite, bring peers into the same session, and verify that each peer actually reached the host. Manual hotspot settings, IP entry, and network troubleshooting are fallbacks for unsupported devices or operator diagnosis.

A host is still required for a shared Wabi workspace. It could be an already-running Authority on the LAN, a supported desktop/portable host, or a future mobile host runtime. A phone hotspot alone only makes a Wi-Fi network; it does not run Wabi's Authority. If no Wabi host is present, direct nearby exchange or store-and-forward is a separate product path with different persistence and delivery guarantees.

Proposed local-session flow:

1. The host taps **Start nearby session** and chooses whether it is internet-connected or local-only.
2. Wabi detects a reachable Authority or starts a local network/host only on supported platforms. It reports a clear blocker if the server host or radio capability is missing.
3. A member taps **Join nearby** and uses an NFC tag, QR, or supported native discovery to receive a short-lived join offer. The OS may still ask the member to approve Bluetooth/Wi-Fi access or network joining.
4. Wabi connects and verifies the Authority. It displays “Local only” when there is no internet route and distinguishes local delivery from eventual upstream synchronization.
5. Wabi closes the temporary network/session when the host ends it, subject to clear confirmation about unsent local messages.

The app must never silently turn on radio discovery, auto-join an unknown network, or bridge local messages into an internet/community channel. OS permissions and any join confirmation remain visible and user-controlled.

| Family | Reach and payload shape | What Wabi could do | Main limit / readiness |
|---|---|---|---|
| **Ordinary LAN/Wi-Fi** | Normal IP while devices can reach the same network or local Authority | Use the current client/server path; make local Authority discovery and joining easier | Underlying access exists; automatic discovery/onboarding is a product improvement, not an alternative bearer or phone-to-phone store-and-forward |
| **Temporary hotspot + local Authority** | A portable Wi-Fi network with no internet uplink; supports normal Wabi web/realtime traffic while clients remain in range | One-click event/field-session setup, QR join, offline status, and an explicit local host lifecycle | Android has an app API for a local-only hotspot, subject to OS/device permission and availability. iPhone Personal Hotspot is a mobile-data sharing feature; use a peer-to-peer link or separate local router/host rather than assuming it will create a no-internet LAN. Wabi still needs a reachable Authority; a hotspot alone does not host Wabi. |
| **NFC/QR session bootstrap** | Deliberate tap or scan exchanges a tiny one-time invite, endpoint, or key fingerprint; a faster/longer-range bearer carries subsequent traffic | Make “tap/scan to join this local Wabi” an intentional, consent-based start for a nearby session | NFC Forum Connection Handover defines bootstrap to another bearer, but app-level phone-to-phone support is not universal. Android Beam was deprecated; Apple Core NFC focuses on reading/writing tags. A static NFC tag/QR invite is more portable, but it must not contain a reusable bearer token. |
| **Nearby Wabi discovery** | Presence discovery among opted-in nearby devices; exchanges a join offer or small data after consent | “Find nearby Wabi people/community” with explicit invite and local transfer | BLE discovery is not a data mesh; mobile background behavior, privacy, battery use, and cross-platform discovery need deliberate design. |
| **Device-to-device custody / store-and-forward** | Short messages travel when devices meet, even without a shared AP; multi-hop may extend beyond radio range | Forward signed, size-limited, expiring check-ins or messages toward a Wabi Authority or permitted peer | A real mesh protocol and durable custody/receipt rules are required. Do not base this on WabiDB replication or tell users messages are delivered until the receiver/Authority confirms. |
| **Bluetooth LE direct link** | Nearby devices; short text, small control packets, or pairing | Discover a consenting nearby Wabi device and hand it a signed, size-limited queued envelope | A link is not automatically a multi-hop mesh. Mobile OS background behavior and app lifecycle constrain persistent relaying. Browser Web Bluetooth is not a dependable cross-browser/background foundation. |
| **Phone peer-to-peer Wi-Fi** | Nearby, larger transfers than BLE; may work without an access point where supported | Move attachments or synchronize a batch after two devices discover each other | APIs and hardware support differ by platform. Android Wi-Fi Aware is optional device capability; Apple's Multipeer Connectivity chooses among Wi-Fi and Bluetooth internally but is an Apple platform API. Cross-platform protocol and lifecycle work remain. |
| **Purpose-built Bluetooth Mesh** | Many-to-many BLE packet network, typically provisioned devices; managed flooding and low-power relay patterns | Connect a Wabi gateway to a deployed mesh, or build an integration for a defined device ecosystem | The Bluetooth Mesh standard does not make ordinary Wabi phone apps a universal public chat mesh. Provisioning, relay capacity, gateway, and phone support are required. |
| **Wi-Fi mesh / community wireless** | Local-area or neighborhood IP, potentially with rooftop/directional backhaul | Run an Authority or gateway at a community hub; clients continue normal Wabi over routed IP | Requires nodes, power, placement, routing/admin, and maintenance. It solves network reach, not offline message synchronization by itself. |
| **LoRa packet mesh** | Long-range, low-rate text/status and small telemetry; multi-hop depends on protocol and topology | Bridge Wabi check-ins, incident forms, short alerts, and acknowledgement states through a radio gateway | Needs compliant radio hardware and local radio expertise. Ordinary sub-1GHz Meshtastic/LoRa links are not a Wabi live voice/video or general file-sync path; airtime and payload are scarce. Meshtastic and Reticulum/RNode are separate ecosystems and are not wire-compatible by default. |
| **Reticulum + LXMF** | A medium-agnostic network/message layer that can combine local IP, LoRa/RNode, packet-radio modems, serial links, and other interfaces | Prefer a thin gateway experiment: Wabi sends selected compact messages to an LXMF endpoint, receives inbound messages, and shows path/delivery metadata | This is an existing independent ecosystem, not a Wabi feature. Its identity/addressing and message model differ from Wabi accounts/rooms; a bridge must map identities and permissions explicitly. It uses custom LoRa MAC over raw LoRa in its RNode setup, not LoRaWAN. |
| **Amateur-radio digital messaging** | HF/VHF/UHF depending on mode and station; APRS for short position/status/messages, JS8Call for weak-signal HF text, Winlink for radio email | An operator-station connector can provide an approved outbound queue and radio inbox for selected Wabi workflows | Requires suitable station/equipment and authorized operators. Throughput, scheduling, reach, acknowledgements, and service rules vary by mode. Amateur radio is not a transparent private internet link. |
| **Open radio voice / PTT** | VHF/UHF analog or open digital voice such as M17; HF digital voice such as FreeDV; direct RF may work without carrier or broadband | Operator dispatch surface, call/event log, and later a station-specific audio/PTT gateway | Requires radio hardware, authorized operators, and a specific audio/control interface. It is not automatically a Wabi browser call or a bridge into a private room. |
| **Through-the-earth / cave radio** | Specialized low-frequency/inductive systems communicate through rock; use depends on geology, antenna, and system | Bridge text-capable systems through a confirmed data interface or existing mesh gateway; provide a Wabi dispatch log and human acknowledgement workflow for voice systems. | Specialist hardware and trained operators; low throughput/range depends heavily on conditions. Cave-Link, Nicola 4, and QDX-M have different integration paths. “Through rock” does not mean arbitrary broadband radio through any terrain. Cave radio is distinct from acoustic data-over-sound. |
| **Mine leaky-feeder / underground radio** | Cable-based radiating systems provide radio coverage along equipped tunnels | A Wabi gateway could use the mine's existing communications/IP system or an approved radio/dispatch interface | Infrastructure has to be installed in the mine. It is not a general portable through-earth network. |
| **Acoustic data-over-sound** | Very short-range exchange through speaker/microphone; audible or near-ultrasonic tones | Experimental nearby handoff, check-in, or pairing token; potentially useful when network pairing is unavailable | Slow, exposed to room noise/echo, requires both devices to play/listen, and short range. Not the same as low-frequency RF or cave radio. |
| **Underwater acoustic modem** | Short text/telemetry underwater through transducers, with substantial latency and low data rates relative to ordinary networking | A research gateway could feed sensor events or expedition status into Wabi when a surface computer is available | Requires specialist modem/transducer hardware; sound propagation and duty cycle constrain use. Not a phone feature. |
| **Satellite / store-and-forward satellite** | Remote-area messages through commercial satellite services or amateur satellites; usually small messages and/or intermittent passes | Optional provider or station adapter for check-ins, distress metadata, or scheduled message delivery | Hardware, coverage, subscription/service APIs, regulations, and provider dependency. Commercial satellite messaging is not automatically open or self-hosted. |
| **PSTN / SMS / SIP trunk** | Normal telephone calls and carrier SMS; broad reach while telecom service is available | Optional Asterisk/FreeSWITCH or provider connector: room-to-call handoff, SMS gateway, event/call status, incident hotline | Requires a PBX, trunk/provider, numbers, and ongoing costs. Not offline. SMS is not private or guaranteed; a provider adds its own data and availability boundary. |
| **Optical / infrared point-to-point** | Line-of-sight light-based data link, usually specialized or short range | Niche gateway for fixed building links, device-to-device signaling, or experiments | Alignment, ambient light, obstruction, and dedicated hardware make this a specialist path rather than a general phone mesh. |

This list covers useful families, not every radio mode, vendor mesh, or experimental physical layer.

## Notable ecosystems to evaluate

### Reticulum and LXMF

Reticulum is the most interesting *cross-medium networking* lead found in this survey. Its documented interfaces include Ethernet/Wi-Fi, TCP/UDP, serial, packet-radio modems, and RNode LoRa. LXMF provides a compact message format/delivery layer designed to work across those media, including very low-bandwidth links. Reticulum docs also describe combining a LoRa edge with higher-capacity Wi-Fi or directional-radio backhaul.

That is attractive as a gateway substrate, not a reason to replace Wabi's Authority or identity model. A Wabi bridge should be narrow, opt-in, and explicit about which rooms and message classes are allowed to cross. It should not claim Wabi accounts, reactions, presence, attachments, or encryption policy transfer automatically.

Reticulum applications can share a local Reticulum instance, which owns the physical interfaces and exposes network access to local programs. LXMF's router API handles message queues, path lookup, retries, delivery confirmation, and inbound delivery. This suggests an integration path that works with the existing network rather than requiring Wabi to own radio drivers:

1. A local, optional Wabi connector joins the operator's existing Reticulum instance (or an explicitly configured local instance) and uses LXMF.
2. The operator maps specific Wabi rooms and Reticulum destinations. Nothing is bridged by default.
3. Outbound messages identify the actual Reticulum/LXMF sending identity. They do not impersonate the Wabi author unless the message format and cryptographic proof really support that claim.
4. Inbound LXMF messages enter a clearly labeled gateway inbox or mapped room with the transport sender and receipt state preserved.
5. The UI distinguishes Reticulum reachability, LXMF delivery confirmation, Wabi Authority acceptance, and human acknowledgement.

First milestone should be an operator-run lab adapter and a compatibility walkthrough with existing LXMF clients, not new WabiDB records or a new transport protocol. A later product surface could make network setup, link health, destination mapping, and test messages approachable to ordinary Wabi communities. This will let Wabi help people discover and participate in the ecosystem while preserving interoperability with its existing tools.

Reticulum also has [LXST voice applications](https://reticulum.network/manual/software.html#voice-telephony) on links with enough capacity; Partyline describes group voice on transports above 6 kbit/s. That is a separate, later voice-interoperability study. A slow RNode/LoRa path suitable for LXMF text should not be presented as a Wabi call fallback.

References: [Reticulum supported hardware](https://reticulum.network/hardware.html), [interfaces](https://reticulum.network/manual/interfaces.html), [sharing a local Reticulum instance](https://reticulum.network/manual/using.html), [LXMF and related software](https://reticulum.network/manual/software.html), [LXMF router API and delivery model](https://github.com/markqvist/LXMF#the-lxm-router), [building networks](https://reticulum.network/manual/networks.html).

### Meshtastic and LoRaWAN are different options

Meshtastic is a decentralized text/telemetry mesh over supported LoRa radios, with optional MQTT bridging. Its [official client API](https://python.meshtastic.org/) can attach directly to a local radio over serial, TCP, or BLE for an offline Wabi adapter. A dedicated gateway radio avoids competing with a person's phone app for the radio's client connection. The [normal application payload](https://meshtastic.org/docs/overview/) is roughly 200 bytes, so Wabi should send deliberately compact messages. Meshtastic also documents an [experimental 2.4 GHz Codec2 audio module](https://meshtastic.org/docs/configuration/module/audio/) for specific hardware; it says sub-1GHz bands cannot carry continuous audio packets on the mesh.

Reticulum's RNode uses raw LoRa with its own network layer. [LoRaWAN](https://lora-alliance.org/about-lorawan/) is a separate low-power wide-area networking standard with a gateway-to-network-server topology; [that server can be local/self-hosted](https://www.chirpstack.io/docs/getting-started/docker.html), but its radio protocol is neither Meshtastic nor RNode/Reticulum. A Wabi integration must choose a concrete ecosystem; “LoRa support” alone does not identify a compatible protocol.

References: [Meshtastic MQTT module](https://meshtastic.org/docs/configuration/module/mqtt/), [Reticulum RNode hardware](https://reticulum.network/manual/hardware.html).

### Radio voice beyond VoIP

Voice without broadband is a separate radio path. [M17](https://m17project.org/about/) develops an open digital voice/data protocol for amateur radio; [FreeDV](https://freedv.org/) provides open digital voice modes over HF radio. Conventional analog push-to-talk is another established path. Wabi could supply an operator console for call initiation/logging, short text follow-up where a radio system supports it, and a hardware audio/PTT gateway after a specific station interface is proven. Service rules, licensing, and disclosure of bridged audio need operator review. This does not make a radio endpoint a Wabi VoIP participant automatically.

### Through-earth radio and cave passage mesh

The [2026 ECRA communications catalogue](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Catalogue-1.60.pdf) gives Wabi several concrete handshake candidates. Cave-Link V2 carries text and can reach a surface SMS interface; SMS forwarding needs cellular service, while its through-earth segment does not. Its [available user manual](https://expo.survex.com/expofiles/documents/hardware/Cavelink2.13_en_2014-3.pdf) does not document a programmatic message protocol. Nicola 4 has been tested for cave voice and text; ECRA reports a working bidirectional Nicola 4–Meshtastic message connection, with cave testing of that combined connection still pending. The QDX-M cave variant carries digital text through a modified low-frequency radio linked by USB to an Android RadioMsg app; ECRA reports about 600 m of through-rock testing under its conditions. These are distinct systems, not generic IP links.

An initial Wabi through-earth demonstration could therefore attach at the **surface Meshtastic gateway** of a Nicola 4 bridge, if its actual packet interface and cave behavior are verified with the project team. Cave-Link needs operator/manufacturer interface cooperation, and QDX-M needs a RadioMsg-side software path and an authorized station. Voice-only radios call for an audio/PTT hardware interface or a human dispatcher recording the exchange in Wabi. The [ECRA Meshtastic report](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Meshtastic-1.00.pdf) also covers radio relays *along cave passages*; that should not be described as a low-frequency signal passing through solid rock. Some cave-focused Meshtastic firmware differs from stock packet formats, so compatibility must be checked per variant.

These paths make Wabi useful as a shared surface/field workspace while the specialist projects keep their native equipment and clients. The [bridge plan](plans/2026-09-27-alternative-communications-bridge.md) separates compact messages, observations, and operator voice logs.

### Amateur-radio examples

- **APRS/APRS-IS:** positions, status, weather, and short messages; APRS-IS has a documented line-oriented TCP interface. Treat RF-gated content as potentially public.
- **JS8Call:** weak-signal HF text messaging with a documented local JSON API.
- **Winlink:** radio email via volunteer/authorized stations, designed for paths where internet is unavailable.

These are operator networks and radio services, not interchangeable Wabi transports. A Wabi adapter should never silently bridge private-room content to a radio channel. Rules on identification, encryption, traffic, and permitted use are service- and jurisdiction-specific; the transmitting operator must verify them.

References: [APRS-IS specification](https://www.aprs-is.net/Specification.aspx), [JS8Call API](https://js8call.com/JS8Call-improved/d7/d15/md_docs_2API.html), [Winlink overview](https://winlink.org/).

## Thailand equipment note

NBTC's current self-declaration information lists Bluetooth equipment in 2400–2500 MHz and a LoRa non-RFID equipment category at 920–925 MHz with a stated transmit-power limit of 50 mW. This is a useful starting point for hardware sourcing, not a blanket determination that every imported board, antenna, firmware, mode, or deployment is lawful. Check the exact device's NBTC certification and current frequency/technical conditions before transmitting. Do not copy a Reticulum example frequency from another region into Thailand hardware configuration.

Reference: [NBTC SDoC equipment categories](https://standard1.nbtc.go.th/บริการออนไลน์/SDoC-Online.aspx). The [NBTC laws and regulations index](https://www.nbtc.go.th/law/กฎหมายและกฎระเบียบที่เกี่ยวข้องกับการค้า/โทรคมนาคม.aspx) is the authoritative place to confirm current notices.

## What a Wabi bridge would need to preserve

Before integrating any bearer, define a transport-neutral envelope and explicit policy:

- stable origin message ID and deduplication across retries/paths;
- sender identity/proof, destination scope, creation time, expiry, and hop limit;
- size, rate, and airtime budgets; fragmentation/reassembly policy if permitted;
- transport state separated into queued, handed to gateway, transport-confirmed, Authority-accepted, and human-acknowledged;
- operator-controlled allowlist of rooms, recipients, and content classes;
- explicit redaction/conversion policy for rich messages, files, links, location, and mentions;
- replay protection, gateway authentication, audit trail, revocation, abuse controls, and per-transport health;
- visible disclosure of the gateway/operator and any public or third-party path.

Do not strip Wabi ciphertext and forward plaintext to satisfy a radio transport. Conversely, do not assume that ciphertext is lawful or useful to send over every radio service. The transport adapter must surface a clear policy decision and the operator must own compliance. Existing experimental Wabi conversation encryption is not an independently verified operator-blind guarantee.

## Suggested exploration order

1. **Join the existing Reticulum ecosystem:** run a local Reticulum/LXMF lab, exchange messages with existing clients, and record exactly which configured interfaces and delivery states are visible. This requires no Wabi feature and proves that Wabi is joining a real ecosystem rather than simulating one.
2. **Build a narrow Wabi connector:** map one test room to one LXMF identity/destination, with explicit inbound/outbound controls, provenance, size limits, and operator-visible delivery states. Keep Wabi Authority canonical and leave other rooms untouched.
3. **Make the ecosystem approachable:** add reviewed setup guides, a diagnostics view for configured transports, sample message formats, and a demo/simulator that teaches the limits before requiring radio equipment. Keep install and device-specific radio configuration optional.
4. **Add another adapter only after the envelope works:** Meshtastic is a good contrast if the goal is specifically low-cost LoRa group messaging. Do not build both adapters first.
5. **Choose the use case before specialist links:** cave/mine radio belongs with rescue, mining, or expedition teams; underwater acoustic links belong with marine research; they deserve a focused partner/hardware project rather than a generic Wabi promise.
6. **Add cellular/SIP separately:** it broadens ordinary reach but does not make the system work when telecom infrastructure is unavailable.

For the general Wabi-to-network integration and an offline radio acceptance proof, see the [alternative communications bridge proposal](plans/2026-09-27-alternative-communications-bridge.md). The [field coordination addon proposal](plans/2026-09-27-field-coordination-addon.md) applies its authorized observations to maps and check-ins.

## References for local/mobile links

- [Android local-only hotspot](https://developer.android.com/develop/connectivity/wifi/localonlyhotspot) is explicitly intended to let connected apps communicate without Internet access; [Android hotspot API reference](https://developer.android.com/reference/android/net/wifi/WifiManager.LocalOnlyHotspotCallback) lists failure/availability states.
- [Apple Personal Hotspot](https://support.apple.com/en-au/111785) shares the phone's mobile-data connection; [Apple Multipeer Connectivity](https://developer.apple.com/documentation/MultipeerConnectivity) is the more relevant native peer-discovery/data-session path for nearby iOS devices.
- [NFC Forum Connection Handover](https://nfc-forum.org/build/specifications/connection-handover-technical-specification/) defines NFC setup for switching a connection to another wireless carrier such as Bluetooth or Wi-Fi. [Android NFC overview](https://developer.android.com/develop/connectivity/nfc) describes NFC as a very short-range technology; [Android 10 behavior changes](https://developer.android.com/about/versions/10/behavior-changes-all) deprecate Android Beam.
- [Apple Core NFC](https://developer.apple.com/documentation/CoreNFC) supports reading/writing NDEF tags, a good basis for a physical tap-to-join tag; it should not be assumed to provide generic phone-to-phone NFC data exchange.
- [Android Wi-Fi Aware](https://developer.android.com/develop/connectivity/wifi/wifi-aware) supports peer discovery and direct data paths without an access point on supported devices.
- [Apple Multipeer Connectivity](https://developer.apple.com/documentation/MultipeerConnectivity) discovers nearby services and uses infrastructure Wi-Fi, peer-to-peer Wi-Fi, and Bluetooth on iOS.
- [Apple Core Bluetooth](https://developer.apple.com/documentation/corebluetooth/) documents native BLE APIs and background behavior.
- [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) has limited browser availability; it is not a sound foundation for background phone relaying.
- [Bluetooth Mesh](https://www.bluetooth.com/learn-about-bluetooth/feature-enhancements/mesh/) uses managed flooding and defined mesh node roles; it should not be conflated with generic smartphone-to-smartphone forwarding.
- [Quiet Modem](https://quiet.github.io/docs/quiet/) encodes low-throughput data in audible or near-ultrasonic sound.
- [AHOI open-source underwater modem](https://www3.tuhh.de/acps/projects/ahoi/) documents a hardware/software acoustic modem and its range/rate constraints.
- [BCRA cave-radio references](https://site2.caves.org.uk/radio/selectedrefs.html), the [2026 European Cave Rescue Association communications catalogue](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Catalogue-1.60.pdf), and [its underground Meshtastic report](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Meshtastic-1.00.pdf) cover cave-rescue systems, through-earth links, and cave passage mesh trials.
