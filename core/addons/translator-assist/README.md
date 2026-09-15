# Translator Assist

Translator Assist is Wabi's optional, frontend-only translation addon.

## Product boundary

- Disabled by default.
- Ships no language model in the base Wabi package.
- Starts no translation service or network request merely by loading Wabi.
- Does not use the Wabi Authority as a translation proxy.
- Does not configure Google or another proprietary cloud translation provider.
- Keeps the original message unchanged; translations are a local presentation layer.
- Code-splits the translation runtime so normal chat does not load it until translation is used.

## Modes

- **Off** — no Translate message action and no translation requests.
- **Translate when asked** — context-menu translation beneath the original message.
- **Automatic** — viewport-aware translation of incoming text the user does not already understand.

Auto mode skips the user's own messages, commands, code-only/URL-only posts, local cards, and languages in the user's understood-language list. Translation work is bounded and cached rather than applied eagerly to channel history.

## Providers

### LibreTranslate on this device

Default endpoint:

`http://127.0.0.1:5000/translate`

Local mode is restricted to loopback hosts (`127.0.0.1`, `localhost`, or `::1`). The user runs LibreTranslate themselves. Wabi connects directly from the client.

### Self-hosted LibreTranslate

Users may explicitly enter an HTTPS LibreTranslate `/translate` endpoint they control or trust. Requests still go directly from the client to that endpoint.

The Wabi server never receives translation plaintext just to relay it to a translator.

## Privacy

Translation can disclose plaintext to the selected translation engine. Local mode keeps that translator connection on the user's device. A remote self-hosted translator necessarily receives the message text needed for detection/translation.

Translator Assist does not change Wabi's encryption model or make additional E2EE claims. See `../../../docs/PROJECT_STATUS.md` for the current product privacy boundary.

## Detailed documentation

Setup, automatic-translation behavior, performance limits, threat model, code map, troubleshooting, and provider guidance are documented in:

`../../../docs/addons/TRANSLATOR_ASSIST.md`
