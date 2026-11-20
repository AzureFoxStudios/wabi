Hey all, sharing a WIP project: "Wabi", a self-hostable communications app (channels, DMs/groups, voice/video/screen share, wiki, forums, project board). MIT FOSS, because I want it to be a tool people run themselves, not a service.

I've been building it since around February with a mix of AI tools. Claude Code did most of it, but Codex had a real job: in early October it did a big consolidation pass, merging dozens of stale branches and dependency bumps back into main without losing work, plus a few features like an Alt-click "Glance" preview for workspace links. Keeping several AIs consistent on one codebase is its own problem; the AGENTS.md in the repo is how I handle it.

Quick heads-up since it's self-hosted: whoever runs a server can read its public channels and stored data, DM encryption is experimental and unreviewed, plugins aren't sandboxed, and the pre-release installers are unsigned.

https://github.com/AzureFoxStudios/wabi
