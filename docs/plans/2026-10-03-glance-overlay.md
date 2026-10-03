# Glance overlay

The requested interaction follows [Zen Glance](https://docs.zen-browser.app/user-manual/glance): Alt-click previews the real destination over the current workspace; outside click, Escape and Close dismiss it; Continue opens the destination normally. This supersedes the earlier proposal to use the right panel.

`GlanceHost` lives in the shell and uses the shared portal and modal focus action. It captures supported reference and website links, while Forum object cards, Lore cards and channel rows explicitly open the same store. Previewing does not call `switchChannel` or consume center-stage `pendingNav`.

Wiki, Forum, Gallery, Lore and text channels reuse their existing readers. Wiki/Forum/Gallery receive separate preview targets; Wiki drafts use a separate surface, and Lore previews cannot edit. Map previews keep their place, layer and point selection local rather than changing the map underneath. Linked images, video and audio render directly because upload responses can prohibit iframe embedding. Other HTTP(S) websites use a sandboxed frame with an explicit Continue fallback when embedding is blocked. Unsupported workspace types explain that they cannot yet preview.

Server/account changes and group revocation retire the overlay. Object references require an accessible, unambiguous channel. Executable, data and local-file URL schemes are rejected.

Validation runs on Iyoku in an isolated directory, following the user's local heat constraint. The release candidate uses live source `636f133b971288577cd402a8c71bfeb31772790a` plus only this Glance patch; shared Office, Payments and other unfinished changes are excluded. The live-base Forum reader additionally needs the existing `tick` import already present on the integration branch.

Before the media repair, actual browser acceptance confirmed exact Wiki content over the forum, outside-click focus restoration, Continue into center stage, text messages, Escape, the Lore file browser and its 175-byte test file, and six gallery items. It also exposed the upload iframe refusal, which the direct media viewers address. Final media/browser and deployment evidence will be recorded after completion. No credentials are included in source or receipts.
