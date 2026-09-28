# Alternative communications research to return to

**Status:** deferred integration dossier, 2026-09-27. These are researched opportunities, not shipped Wabi features or field-proven Wabi transports. The active, testable local work is the [mixed-phone field trial](2026-09-27-local-field-communications-trial.md). The [transport inventory](../COMMUNICATIONS_TRANSPORTS.md) gives the wider technology map; the [communications bridge proposal](2026-09-27-alternative-communications-bridge.md) defines Wabi's common adapter boundary.

## How to read this dossier

The word *network* is too broad here. Keep three layers separate:

1. **Physical bearer:** radio, Wi-Fi, copper wire, light, acoustic sound, or satellite path. It determines power, range, throughput, and whether rock/water/terrain blocks the signal.
2. **Network and message protocol:** Reticulum/LXMF, Meshtastic, LoRaWAN, APRS, JS8Call, Winlink, M17, or a vendor cave-radio format. Using the same LoRa modulation does not make protocols compatible.
3. **Wabi-facing adapter:** maps an explicitly authorized subset of messages or observations into Wabi's one Authority. It needs an identity map, delivery states, admission checks, deduplication, and a clear disclosure of where content travels.

Wabi can run normally wherever an IP link is strong enough and reaches its Authority. A very narrow radio link calls for compact text/status or a separate voice/dispatch interface. A radio peer may continue using their native network while Wabi is unreachable; Wabi cannot assert a new canonical message or live receipt until its gateway reaches the Authority. WabiDB replication and the legacy mesh addon are not shortcuts to phone-to-phone operation.

## Priority snapshot

| Candidate | Why it matters | Wabi proof to build when equipment is available | State now |
|---|---|---|---|
| **Reticulum + LXMF** | Existing cross-medium network and interoperable delayed messaging | Wabi room ↔ unmodified Sideband/LXMF client over a real configured radio path, with no WAN | Protocol lab can begin without radio; Wabi adapter absent |
| **Meshtastic** | Complete low-rate LoRa text/position ecosystem with radios, apps, and an accessible client API | Wabi room ↔ unmodified Meshtastic client via a dedicated local gateway radio; no MQTT/internet required | Wabi adapter absent; hardware and Thailand-compliant setup needed |
| **Nicola 4 ↔ Meshtastic** | Reported bridge from cave through-earth text into a mesh-side system | Receive a cave-origin message in Wabi and return a human acknowledgement; verify the combined path underground | ECRA reports bidirectional messages but says cave testing of combined link remains |
| **Other cave TTE** | Cave-Link and QDX-M already carry text; HeyPhone-like systems carry voice | Equipment-specific API or dispatch interface with partner/operators | API access, equipment, and partners unknown |
| **Amateur radio data/voice** | HF/VHF/UHF may reach beyond local infrastructure | Operator-station inbox or audio/PTT gateway for one chosen mode | No Wabi connector or authorized field station in this work |
| **LoRaWAN/satellite/acoustic/optical** | Useful sensor, remote, or specialist bearers | One purpose-built adapter per real deployment | Exploratory |

## Reticulum, LXMF, and the wider RNS ecosystem

**What exists.** [Reticulum](https://reticulum.network/manual/whatis.html) is a network stack that can run over several configured interfaces: RNode/LoRa, packet radio, serial, local Wi-Fi/Ethernet, and IP. [LXMF](https://github.com/markqvist/LXMF#the-lxm-router) is a message format/router with outbound and inbound queues, retries and delivery receipts. [Sideband and other clients](https://reticulum.network/manual/software.html) already use it. Reticulum programs can join a [shared local instance](https://reticulum.network/manual/using.html) instead of each opening the physical radio interface.

**Wabi handshake.** A small optional sidecar runs near the Authority, joins the operator's Reticulum instance, owns a visible LXMF destination, and sends/receives only for approved Wabi destinations. Inbound messages retain their LXMF sender identity and transport provenance. Wabi replies identify the bridge as the LXMF sender; it must not pretend the original Wabi account has an LXMF key. Display Wabi acceptance, bridge queue, network handoff, LXMF receipt, and human response as different facts.

**No-hardware lab now.** Two local Reticulum/LXMF programs can exchange over local interfaces, making a valid protocol and adapter development lab. That test says nothing about range or independence from a router. A future field proof needs RNode/packet-radio hardware at both ends, a real no-WAN route, an existing client, and delay/disconnect trials. No public Reticulum node is required if the two stations can form their own configured path.

**Voice nuance.** Reticulum also has [LXST voice applications](https://reticulum.network/manual/software.html#voice-telephony); Partyline describes group voice on transports above 6 kbit/s. A specific fast interface could be studied later. A slow RNode/LoRa text test does not establish a Wabi call fallback.

## Meshtastic: the recurring practical radio project

**Why it recurs.** [Meshtastic](https://meshtastic.org/docs/introduction/) packages LoRa radio firmware, relaying, phone/desktop access, short text, optional position, telemetry, and community-developed deployments. The [official Python API](https://python.meshtastic.org/) exposes serial, TCP, and BLE connection options plus text and position receive events. This makes it both a useful independent network and a realistic gateway surface for Wabi. Ordinary application data is [roughly 200 bytes per packet](https://meshtastic.org/docs/overview/), so compact messages and check-ins are the right initial content.

**No stranger's network needed.** When equipment is available, two privately configured, region-compliant nodes can form a test network. One can be the Wabi hub's dedicated serial/TCP radio and the other a remote member's radio with their normal Meshtastic app. A third node is useful for testing relaying but is not necessary for the first direct-link handshake. This avoids depending on public Bangkok nodes or asking their operators to carry experimental Wabi traffic. Check exact Thai equipment and radio settings against current [NBTC equipment rules](https://standard1.nbtc.go.th/บริการออนไลน์/SDoC-Online.aspx) before transmission.

**Wabi handshake.** A dedicated gateway radio connects to an optional Wabi adapter. Wabi maps selected text/check-in events to a named Meshtastic node/channel and labels inbound node/channel identity. The hub can be a local Wabi Authority with no WAN. MQTT is an optional Meshtastic integration, but the offline proof uses the local radio interface. Because a Meshtastic radio generally serves one client connection at a time, a dedicated gateway avoids displacing someone's phone app. Wabi should distinguish local queueing, radio send, mesh acknowledgement, recipient response, and human acknowledgment; a broadcast acknowledgement is not a read receipt.

**Limits and variants.** Meshtastic, Reticulum/RNode, and LoRaWAN all may use LoRa modulation but have different on-air packets and require separate adapters. Short radio packets and shared airtime rule out full Wabi conversation synchronization, live video, and normal voice. Meshtastic documents an [experimental Codec2 audio module](https://meshtastic.org/docs/configuration/module/audio/) for certain 2.4 GHz hardware and explicitly says sub-1GHz bands cannot support continuous mesh audio. [Position](https://meshtastic.org/docs/configuration/radio/position/) and [telemetry](https://meshtastic.org/docs/configuration/module/telemetry/) cadence vary; a map shows last report age rather than live radar. Cave-focused forks may change packet format; the [ECRA report](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Meshtastic-1.00.pdf) says Flamingo cannot talk to stock Meshtastic radios.

**Return gate.** Get two compliant nodes; verify a private native-client exchange; attach one dedicated node to the Wabi bridge; repeat messages with internet/cellular routes absent; inspect duplicates, payload cutoffs, hop behavior, and displayed receipt meanings. Publish the exact radio model, firmware variant, band, and field conditions with the result.

## Underground, through-rock, and cave-passage systems

The [2026 European Cave Rescue Association (ECRA) catalogue](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Catalogue-1.60.pdf) is the current starting point. It distinguishes low-frequency/inductive transmission through rock, mesh radios placed along passages, installed wire/leaky-feeder systems, and voice-only equipment. They need different Wabi integration classes.

| System | Native capability and known evidence | Possible Wabi touch point | What remains to establish |
|---|---|---|---|
| **Nicola 4** | Voice and text tested in caves; ECRA reports bidirectional Nicola 4–Meshtastic messaging outside a completed combined cave trial. | Meshtastic-side gateway for text, preserving original cave sender; operator dispatch for voice. | Work with Nicola/cave operators; identify packet fields and message acknowledgements; test combined path underground. |
| **Cave-Link V2/V4** | V2 carries short text, repeaters, and optional surface GSM SMS. The [V2 manual](https://expo.survex.com/expofiles/documents/hardware/Cavelink2.13_en_2014-3.pdf) lists a serial interface but no published messaging protocol. ECRA describes V4 phone integration as development/prototype work. | Partner-maintained data interface or surface gateway; SMS bridge only when cellular exists. | Manufacturer/operator interface specification, equipment, and explicit no-cell trial of the through-earth segment. |
| **QDX-M cave variant + RadioMsg** | ECRA describes modified 137.5 kHz digital text equipment connected to Android by USB and reports about 600 m through-rock testing under its conditions. | RadioMsg-side text export or operator gateway. | Local software interface, licensed/authorized operators, applicable band rules, repeatability in another cave. |
| **HeyPhone and similar voice TTE** | Analog low-frequency voice/PTT rather than a published packet API; [BCRA HeyPhone material](https://bcra.org.uk/creg/heyphone/) calls the old design obsolete. | Human radio dispatcher records messages/acknowledgements in Wabi; an audio/PTT interface only with real hardware access. | Equipment partner, audio levels/PTT control, operating procedure, permission to bridge/record audio. |
| **Meshtastic along cave passages** | [ECRA's separate report](https://caverescue.eu/wp-content/uploads/2026/03/ECRA-Communications-Meshtastic-1.00.pdf) documents cave/mine relays, including work with Gloucester Cave Rescue and the 89th Reading Scouts. | Meshtastic gateway and Wabi field/incident view. | Exact stock/fork compatibility, node placement, battery/latency and failure drills. Relaying around rock is not the same as transmitting through solid rock. |
| **Dataphone / leaky-feeder / wired cave network** | Installed copper or radiating cable can create a local data or voice path; ECRA describes Dataphone's VDSL-style cave network. | Normal Wabi over sufficient IP bandwidth, or an approved dispatch interface. | Installed infrastructure, power, route to Authority, and deployment operator. |

The sound in an audible modem is an acoustic carrier. Cave TTE radios use electromagnetic/inductive methods at low frequencies. The two should not share a feature promise just because a receiver makes a signal audible to a human.

## Amateur-radio text and open radio voice

- **APRS** is useful for short position/status/messages. [APRS-IS](https://www.aprs-is.net/Specification.aspx) has a documented TCP packet stream, but APRS-IS itself depends on IP; a fully no-internet trial needs a local RF station and appropriate interface. RF-gated information can become widely visible.
- **JS8Call** supports weak-signal HF text and has a [local JSON API](https://js8call.com/JS8Call-improved/d7/d15/md_docs_2API.html). Wabi could offer an operator-approved short-message queue, keeping delays and station callsigns visible.
- **Winlink** is [radio email](https://winlink.org/) via an authorized station/service. It fits delayed reports or forms better than live chat; service availability and message rules differ from a Wabi room.
- **M17** develops [open digital radio voice/data](https://m17project.org/about/) for amateur operators. **FreeDV** offers [open digital voice modes over HF](https://freedv.org/). Analog PTT radio is another voice path. Wabi could be a dispatch log or, after an equipment-specific integration, an audio/PTT control point. None is a generic browser VoIP relay.

An amateur station is a regulated service, not a neutral private packet pipe. Before sending Wabi content, an operator must choose a legal mode, frequency, identification and message class under the actual jurisdiction and service rules. In particular, do not auto-forward private-room contents or assume Wabi ciphertext can be transmitted on every service.

## Other physical paths

| Path | Practical scope | Wabi work if a partner/use case appears |
|---|---|---|
| **LoRaWAN** | [Gateway plus network server](https://lora-alliance.org/about-lorawan/) for low-power devices; a [local server](https://www.chirpstack.io/docs/getting-started/docker.html) can remove cloud dependency. It is a separate protocol, usually a sensor/telemetry choice. | Import authenticated sensor/check-in events into a field session; do not present it as Meshtastic peer chat. |
| **Community Wi-Fi mesh / fixed radio backhaul** | If it provides routed IP to an Authority, ordinary Wabi can work, subject to capacity and power. | Discovery, onboarding, offline asset maps, network health; no special chat protocol required. |
| **Underwater acoustic modem** | Specialist transducers and slow/high-latency underwater data; [AHOI](https://www3.tuhh.de/acps/projects/ahoi/) is an open modem project. | Sensor or expedition observation gateway at the surface; equipment partner required. |
| **Audible or near-ultrasonic phone sound** | [Quiet Modem](https://quiet.github.io/docs/quiet/) encodes small data as sound in air. Useful for a close pairing token or tiny handoff, vulnerable to ambient noise. | Experimental nearby bootstrap, not through-rock radio or group coverage. |
| **Optical/infrared** | Line-of-sight physical links; specialist fixed-site or device-pair setup. | Treat as an IP/data bearer only after an actual modem/interface and range test. |
| **Satellite/store-and-forward** | Remote messaging may rely on provider hardware, fees, coverage and APIs or scheduled amateur passes. | Narrow check-in/incident adapter for a chosen provider/station; keep provider receipt separate from human reply. |
| **Carrier SMS/PSTN/SIP** | Broad reach when telecom infrastructure works; PBX/provider and numbers needed. | Separate phone/SMS connector for accessibility and ordinary reach, not an off-grid proof. |

## Common acceptance record for any future adapter

Document the native client/hardware and firmware, physical bearer, legal operating configuration, which party runs the Wabi Authority, exact local connector/API, test topology, whether WAN/cellular was disabled, usable payload and latency, energy/duty-cycle behavior, identity mapping, content disclosure, each delivery/acknowledgement level, loss/retry/duplicate behavior, and what happens during an Authority partition. Publish failures and unsupported content alongside successful messages. Classify an adapter as **proposal**, **software-lab interoperable**, **physical no-WAN field demonstrated**, or **supported**; do not infer one from another.

## Return order

1. Continue the local mixed-phone Wabi trial and build its general message/check-in/observation contract.
2. Implement a small LXMF lab adapter against an unmodified client. This can progress without radio equipment and should reuse the general admission/receipt contract.
3. When two private, compliant radio devices are available, run an RNode/LXMF or Meshtastic no-WAN field test. Meshtastic may be the clearest public hardware demonstration; keep the adapters separate.
4. Approach cave/rescue operators only with a defined question and proposed interface, especially Nicola 4–Meshtastic. Let their team validate equipment and operating conditions.
5. Add amateur voice/data, satellite, underwater, and sound/optical integrations in response to a real operator or expedition use case.
