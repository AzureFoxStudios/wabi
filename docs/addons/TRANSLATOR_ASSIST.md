# Translator Assist

**Status:** Optional bundled frontend addon  
**Addon ID:** `translator-assist`  
**Current manifest version:** `0.2.0`  
**Default state:** Off

Translator Assist adds per-user message translation to Wabi without making translation infrastructure part of the normal Wabi server or startup path.

The official Wabi implementation is deliberately local-first and vendor-neutral in the important sense: **Wabi does not configure Google, Azure, or another proprietary cloud translator.** The supported provider contract in this version is LibreTranslate, either on the user's own device or at a self-hosted HTTPS endpoint chosen by the user.

## Goals

- Make multilingual communities usable without duplicating channels by language.
- Provide X/LINE-style inline translations while always preserving the original message.
- Make automatic translation a per-user preference, not a server-wide rewrite of chat.
- Keep translation off the Wabi Authority data path.
- Add effectively zero runtime/network cost for users who leave the addon off.
- Keep translation engines and language models out of the base Wabi package.
- Fail quietly and safely when automatic translation is unavailable.

## Non-goals

- Wabi does not operate a public translation service.
- Wabi does not bundle a proprietary cloud SDK or provider account.
- Wabi does not silently fall back to an internet translation service.
- Translations do not replace, edit, or become the canonical stored message.
- Translated output is not treated as active Wabi syntax; it is a presentation layer, not a source of commands or mentions.
- Translator Assist does not change Wabi's encryption or server-readability model.

## User modes

### Off

This is the default.

- The message **Translate** action is hidden.
- Automatic translation is inactive.
- The translation runtime is not loaded.
- No translation request is made.

### Translate when asked

A user can open a message's context menu and choose **Translate**. The original message remains visible and the translated text is rendered below it.

Selecting Translate again for a manually translated message hides that local translated view. The underlying Wabi message is never modified.

### Automatic

Automatic mode translates only messages the user is actually reading or is about to scroll into view.

The client:

1. waits until an incoming message enters a small viewport margin;
2. ignores the user's own messages;
3. considers normal text and GIF captions only;
4. skips commands, code-only posts, URL-only posts, mention-only posts, local cards, and unsuitable/empty text;
5. asks the selected translator to detect the source language;
6. skips the message when that language is in **Languages I understand**;
7. translates remaining messages to **Translate into**;
8. renders the result locally under the original.

Failure to detect a language is fail-closed: the message is left untranslated rather than guessed.

## Settings

Translator Assist settings are per client/user and stored locally.

- **Mode:** Off / Translate when asked / Automatic
- **Provider:** LibreTranslate on this device / Self-hosted LibreTranslate
- **Translate into:** target BCP-47-like language code such as `en`, `th`, or `ja`
- **Languages I understand:** comma-separated language codes that Auto mode should leave alone
- **Translator endpoint:** shown for self-hosted mode
- **Check translator:** checks provider reachability and available languages without sending chat text

The settings key is:

```text
addon.translator_assist.settings
```

## Provider setup

### Option A: LibreTranslate on this device

Wabi's local provider is fixed to the loopback interface:

```text
http://127.0.0.1:5000/translate
```

Remote hosts cannot be saved into the local provider slot.

The Add-ons settings page includes a copyable Docker command:

```bash
docker run -d --name wabi-translate --restart unless-stopped -p 127.0.0.1:5000:5000 libretranslate/libretranslate:latest
```

After it starts, use **Check translator** in Wabi.

LibreTranslate's official installation documentation also supports Python:

```bash
pip install libretranslate
libretranslate
```

LibreTranslate may download language models on initial startup. Operators who only need a known language set can use LibreTranslate's `--load-only` option (or its corresponding `LT_LOAD_ONLY` environment variable) to reduce model/startup cost.

Upstream references:

- https://docs.libretranslate.com/guides/installation/
- https://docs.libretranslate.com/guides/api_usage/
- https://github.com/LibreTranslate/LibreTranslate

### Option B: Self-hosted LibreTranslate

Enter the complete `/translate` endpoint, for example:

```text
https://translate.example.org/translate
```

Rules:

- Remote self-hosted endpoints must use **HTTPS**.
- Wabi connects from the client directly to the endpoint.
- The endpoint must permit requests from the Wabi client/browser environment (including appropriate CORS configuration for web clients).
- The Wabi Authority is not a translation relay.
- This version does not distribute a community-wide shared LibreTranslate secret. If an operator requires API-key authentication, keys should be per user/client rather than a single server secret copied into every client; first-class per-user key UI is not part of this version.

## Data flow

### On-demand, local provider

```text
Wabi message already visible to user
            |
            v
Wabi client -> 127.0.0.1 LibreTranslate
            |
            v
translated text in local UI
```

### On-demand, self-hosted provider

```text
Wabi message already visible to user
            |
            v
Wabi client -> chosen HTTPS LibreTranslate instance
            |
            v
translated text in local UI
```

### Automatic mode

```text
rendered message
      |
IntersectionObserver: near viewport?
      |
      v
candidate filter -> language detection -> understood-language check
                                           |
                                           v
                                      translate if needed
                                           |
                                           v
                                    local translated view
```

There is no Wabi Authority hop in the translation request path.

## Privacy boundary

Translation necessarily gives plaintext to whichever translation engine performs the operation.

With **local mode**, that engine is reached only over loopback on the same device. With **self-hosted mode**, the message text needed for detection/translation is sent directly to the HTTPS endpoint the user selected.

Translator Assist does not make a stronger encryption claim than Wabi itself. The current Wabi project-status document does not claim end-to-end encryption for ordinary DMs/private rooms. If Wabi later has a client-side encrypted message path, choosing a remote translator would still disclose the decrypted plaintext to that translator; a local/on-device engine would preserve the tighter client-local boundary.

Wabi sends no Wabi bearer token to the translator. Translation fetches use `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.

## Performance and no-bloat behavior

The base product carries only a small settings/capability shim for this bundled addon.

The networking/cache runtime is dynamically imported only when translation work is requested. Auto mode's scheduling code is likewise loaded only when needed.

Guardrails:

- automatic translation concurrency: **2** requests/tasks at a time;
- translator request timeout: **12 seconds**;
- direct translation cache: **400** entries;
- automatic-decision/result cache: **500** entries;
- provider failure cooldown for Auto mode: **15 seconds**;
- automatic text maximum: **8,000 characters**;
- viewport prefetch margin: **180 px**;
- no full-history eager translation.

Language models are not included in Wabi. Any models used by local LibreTranslate live with that external translator installation.

## Message semantics

The original `Message` remains unchanged.

Translation state is local UI state. It is not written back to WabiDB, broadcast over chat, or substituted into reply/edit/moderation data.

The translated block is rendered as text. A translator producing text that looks like `@everyone`, `/ban`, a Wabi reference, or markdown does not turn that translation into an active command or canonical message entity.

## Failure behavior

### Local service is not running

**Check translator** reports that no service answered on `127.0.0.1:5000`.

On-demand translation reports a request failure on the message. Auto mode stays quiet and temporarily backs off so a dead translator does not produce one failing request for every visible message.

### Self-hosted URL is invalid

Non-HTTP(S) URLs are rejected. Remote HTTP endpoints are rejected; use HTTPS.

### Language detection fails

Auto mode leaves the message alone.

### Translator does not support a requested language

The upstream error is surfaced for an on-demand request. Auto mode suppresses repeated failure noise and backs off briefly.

## Security decisions

The old archived `translator-assist` backend accepted a client-provided `providerUrl` and fetched it through the Wabi backend. That design is intentionally **not** restored.

The current implementation avoids that server-side arbitrary-fetch/SSRF-shaped boundary entirely:

- local provider -> loopback only;
- self-hosted provider -> explicit HTTPS URL;
- requests originate from the user's client;
- the Wabi Authority never proxies translator requests.

## Code map

Canonical addon metadata/documentation:

```text
core/addons/translator-assist/plugin.json
core/addons/translator-assist/README.md
```

Frontend settings and lightweight boundary:

```text
frontend/src/lib/components/message/messageTranslator.ts
frontend/src/lib/components/settings/addons/UtilitiesSection.svelte
frontend/src/lib/addons/translatorAssist.ts
```

Lazy runtime and Auto Translate:

```text
frontend/src/lib/addons/translatorAssistRuntime.ts
frontend/src/lib/addons/translatorAuto.ts
frontend/src/lib/addons/translatorViewport.ts
frontend/src/lib/components/MessageItem.svelte
```

Message UI integration:

```text
frontend/src/lib/components/MessageContextMenu.svelte
frontend/src/lib/components/message/MessageContent.svelte
```

Tests:

```text
frontend/src/lib/components/message/messageTranslator.test.ts
```

## Disable/uninstall behavior

Setting Translator Assist to **Off** stops new translation activity immediately and hides the Translate action. Existing canonical messages are unaffected because the addon never rewrites them.

Disabling the addon through the addon lifecycle also forces its local translation mode to Off.

Removing Translator Assist code does not require a WabiDB migration; its preferences and translation caches are client-local/non-authoritative.

## Third-party providers

Wabi's official addon intentionally ships no Google integration. A third party is free to write and maintain a separate provider/addon, subject to Wabi's normal addon trust and disclosure requirements.

Such an integration must not masquerade as local translation. It should clearly disclose:

- where message plaintext is sent;
- what credentials are required;
- retention/logging behavior of the provider;
- whether automatic mode sends every visible foreign-language message;
- how to disable and remove the integration.

Official Wabi code should remain usable without any centralized translation vendor.

## Future extensions

Useful future work that does not require changing the current privacy boundary:

- an optional downloadable browser/WASM or native FOSS translation engine;
- separately downloaded language packs rather than models in the Wabi installer;
- community terminology/glossaries;
- per-channel Auto Translate overrides;
- Reader translation using the same provider interface;
- translated live captions once call-caption infrastructure has a stable local text stream;
- optional per-user API-key support for protected self-hosted LibreTranslate instances.

None of those should require making translation a Wabi core server dependency.
