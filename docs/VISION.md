# What Wabi is for

Stated by the owner on 2026-11-13. This page says what Wabi is trying to be. It makes no claim about what is finished: `docs/PROJECT_STATUS.md` does that, and `docs/PRIVACY_STANCE.md` says what is and is not protected.

## Why it exists

Wabi started out of frustration with Discord: little privacy, little say for the people using it, slow development, features behind a paywall. The best app available was also a poor one to depend on.

The aim is Discord's polish, the flexibility of TeamSpeak and Mumble (more than one call at once), and tools a community grows into (maps, office documents, 3D viewing and more), in something a community runs for itself.

It is **not a Discord clone and not a full replacement**. It is a set of tools that lets people leaving Discord find a long-term home of their own, and do more there.

## What it must be

1. **A communications app first.** Chat, direct messages and calls come before everything else. The app stays out of the user's way.
2. **Easy to set up.** A person who is not a system administrator gets from a blank machine to a running server with a friend invited, without a manual. Matrix's first-run complexity is the example of what to avoid.
3. **Private and in the users' hands.** A community chooses its own server and operator. Wabi says plainly what the server can read and what it cannot, and never claims more than it enforces.
4. **Light when you want it light.** A terminal client (CLI/TUI) can stand in for the full interface on a machine that should be doing something else.
5. **Able to grow with a community.** Today that means one server on one machine for a small or mid-sized community. Running across several machines is experimental and is not part of this promise until it is proven.
6. **Stable for the long term.** Standard, published formats and protocols over home-made ones. Data written today stays readable.

## Three tiers

Tiers say how much a thing matters, not how finished it is. Experimental encryption for direct messages is core in importance and still experimental in maturity.

| Tier | What is in it | Rule |
|---|---|---|
| **Core** | Chat, direct messages and groups, voice and calls (including several calls at once), install, backup, upgrade and recovery, the terminal client, switching between servers | Must be excellent. Regressions here stop other work. |
| **Tools** | Workspaces (wiki, forum, whiteboard, gallery, albums, maps, documents and sheets, 3D and CAD review, planning), Lore, payments, games, plugins | Optional. A tool may never weaken a core guarantee. A tool that cannot honour a room's protection is switched off in that room. |
| **Experimental** | Replication, standby, Anchor, mesh, pilots | Off by default and labelled. Never described as finished. |

## Three questions for any change

1. Does this get in the way of someone who only wants to talk?
2. Does this make installing, backing up or restoring a server harder, or add another file an operator has to remember?
3. Does every word the user sees about privacy match what the code enforces?

If the answer to any of them is unfavourable, say so in the pull request before building further.

## Not yet measured

- Nothing tests the install from nothing by a non-expert.
- "Able to grow" has no number attached. The owner has not set one.
