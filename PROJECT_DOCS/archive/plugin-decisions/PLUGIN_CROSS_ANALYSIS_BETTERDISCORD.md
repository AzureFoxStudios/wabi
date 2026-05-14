# Plugin Cross Analysis: Local Folder vs BetterDiscord Plugins

## Inputs
- Local folder scanned: `C:\Users\Willp\Documents\GitHub\Plugins`
- Local plugin count: `48`
- Remote catalog target: `https://betterdiscord.app/plugins` (JS-only page)
- Cross-check method: plugin-by-plugin lookup against `betterdiscord.app/plugin/<Name>` search results

## Summary
- Local plugins matched to BetterDiscord plugin pages: `43 / 48`
- Not found via current BetterDiscord plugin-page lookup: `5 / 48`

## Found On BetterDiscord (43)
BetterFriendList, BetterNsfwTag, BetterSearchPage, CharCounter, ChatAliases, ChatFilter, ClickableMentions, CompleteTimestamps, CustomStatusPresets, DisplayServersAsChannels, EditChannels, EditRoles, EditServers, EditUsers, EmojiStatistics, FriendNotifications, GameActivityToggle, GoogleSearchReplace, ImageUtilities, LastMessageDate, MessageUtilities, NotificationSounds, OldTitleBar, PersonalPins, PinDMs, QuickMention, ReadAllNotificationsButton, RemoveNicknames, RevealAllSpoilers, ServerCounter, ServerDetails, ServerFolders, ServerHider, ShowBadgesInChat, ShowConnections, SpellCheck, SplitLargeMessages, SpotifyControls, StaffTag, TopRoleEverywhere, Translator, UserNotes, WriteUpperCase

## Not Found In Current Lookup (5)
- CustomQuoter
- HideMutedCategories
- OpenSteamLinksInApp
- RemoveBlockedUsers
- TimedLightDarkMode

## Observations
1. The local folder is effectively a **single-author pack** (DevilBro / `mwittrien/BetterDiscordAddons`) rather than a broad sample of the full BetterDiscord ecosystem.
2. BetterDiscord’s plugin ecosystem is broader than this folder (example non-local catalog entries observed during scan: `ActivityFilter`, `AllCallTimeCounter`, `RoleExplorer`, etc.).
3. The five "not found" entries may be:
   - delisted/renamed,
   - no longer indexed consistently by search,
   - or mapped under changed slugs.

## Actionable Next Step
Use the `43` confirmed matches as your stable intake queue first. Treat the `5` unmatched entries as secondary/manual verification items.

