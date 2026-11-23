Hey all, wanted to share a WIP project here because Hermes was a big part of how I got into building with AI in the first place.

"Wabi" is a self-hostable communications app: channels, DMs/groups, voice/video/screen share, wiki, forums, a project board. MIT FOSS, because I want it to be a tool people run themselves, not a service.

Hermes is what helped me understand how different models work, and it always felt like it understood and remembered what mattered to the project. It wrote a lot of my early plans, handled the deployment side (I'd hand it notes whenever a feature landed), and it even lives inside Wabi: the bot platform was first built so Hermes could post into channels, and there's still a hermes-bot account baked into the server. These days I use a mix (mostly Claude Code, some Codex), but Hermes is a big reason I got this far.

Quick heads-up since it's self-hosted: whoever runs a server can read its public channels and stored data, DM encryption is experimental and unreviewed, plugins aren't sandboxed, and the pre-release installers are unsigned.

https://github.com/AzureFoxStudios/wabi
