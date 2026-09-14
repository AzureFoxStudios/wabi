# Translator Assist

Translator Assist is Wabi's optional, frontend-only translation addon.

## Product boundary

- Disabled by default.
- Ships no language model in the base Wabi package.
- Starts no worker, service, or network connection merely by loading Wabi.
- Does not use the Wabi Authority as a translation proxy.
- Does not configure Google or another proprietary cloud translation provider.
- Keeps the original message unchanged; translations are a local presentation layer.

When the addon is off, the Translate action is hidden from message menus.

## Providers

### LibreTranslate on this device

Default endpoint:

`http://127.0.0.1:5000/translate`

Local mode is restricted to loopback hosts (`127.0.0.1`, `localhost`, or `::1`). The user runs LibreTranslate themselves. Wabi connects directly from the client.

### Self-hosted LibreTranslate

Users may explicitly enter an `http://` or `https://` LibreTranslate `/translate` endpoint they control or trust. Requests still go directly from the client to that endpoint.

The Wabi server never receives translation plaintext just to relay it to a translator.

## Privacy

Translation can disclose plaintext to the selected translation endpoint. This is especially important for E2EE conversations: encryption protects transport/storage, but a remote translator necessarily receives the plaintext the participant asks it to translate.

For private/E2EE conversations, localhost/on-device translation is the preferred path. A future native model runtime should preserve this same boundary: decrypt locally, translate locally, render locally.

## Current UX

- Off
- Translate when asked
- Source language: automatic
- Per-user target language
- Per-user understood-language list retained for automatic translation work
- Per-user translation cache in memory
- Original message remains visible with translated text rendered below it

## Next phase

Automatic translation should be implemented at the message timeline boundary rather than by a DOM observer or message mutation. The intended flow is:

1. Only inspect visible/new text messages.
2. Detect language locally or through the user's chosen translator.
3. Skip languages in the user's understood-language list.
4. Translate into the user's target language.
5. Cache by message revision/text + provider + target language.
6. Invalidate on edit.
7. Never turn translated output into active mentions, commands, or other executable Wabi syntax.

Language packs/native translation engines must remain separately downloaded assets; they do not belong in the base Wabi binary.
