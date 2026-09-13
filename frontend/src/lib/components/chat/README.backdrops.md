# Chat backdrops

`ChatBackdropHost.svelte` is intended to be mounted as the first child of the primary chat surface (`.chat-container` / `.chat-content`). The host subscribes to `wabi:chat-backdrop-change` and browser storage events so settings apply without a reload.

`ChatBackdropSettings.svelte` should be exposed from the Appearance/Theme settings area.

The active scene is client-owned. Server-provided backdrop suggestions can be layered on later without taking away the user's local override.
