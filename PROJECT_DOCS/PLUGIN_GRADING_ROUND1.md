# Plugin Grading (Round 1)

Source scanned: `C:\Users\Willp\Documents\GitHub\Plugins`

Scoring model: fast triage using the A/B/C/D/F rubric from `PLUGIN_PORTING_MASTER_PLAN.md`.
Use this as prioritization input; detailed per-plugin factor scoring happens when a plugin enters active implementation.

| Plugin | Score | Grade | Decision | Band | Description |
|---|---:|:---:|---|---|---|
| ChatAliases | 88 | A+ | Build Now | High-impact core UX | Allows you to configure your own Aliases/Commands |
| ChatFilter | 88 | A+ | Build Now | High-impact core UX | Allows you to censor Words or block complete Messages/Statuses |
| CustomQuoter | 88 | A+ | Build Now | High-impact core UX | Brings back the Quote Feature and allows you to set your own Quote Formats |
| ImageUtilities | 88 | A+ | Build Now | High-impact core UX | Adds several Utilities for Images/Videos (Gallery, Download, Reverse Search, Zoom, Copy, etc.) |
| MessageUtilities | 88 | A+ | Build Now | High-impact core UX | Adds several Quick Actions for Messages (Delete, Edit, Pin, etc.) |
| NotificationSounds | 88 | A+ | Build Now | High-impact core UX | Allows you to replace the native Sounds with custom Sounds |
| PinDMs | 88 | A | Build Now+ | High-impact core UX | Allows you to pin DMs, making them appear at the top of your DMs/ServerList |
| SpellCheck | 88 | A | Build Now+ | High-impact core UX | Adds a Spell Check to all Message Inputs. Select a Word and Right Click it to add it to your Dictionary |
| SplitLargeMessages | 88 | A | Build Now+ | High-impact core UX | Allows you to enter larger Messages, which will automatically split into several smaller Messages (we have no cap on wabi, admin settings should allow a cap to be instilled) |
| Translator | 88 | A | Build Now | High-impact core UX | Allows you to translate incoming and your outgoing Messages within Discord (USER NOTE THIS IS ALREADY A PLUGIN, PLEASE CROSS-COMPARE AND BUILD THE BEST VERSION) |
| BetterFriendList | 78 | B+ | Build Later | Strong QoL, moderate priority | Adds extra Controls to the Friends Page, for example sort by Name/Status, Search and Amount Numbers, new Tabs |
| BetterSearchPage | 78 | B+ | Build Later | Strong QoL, moderate priority | Makes the Controls in the Search Results Page sticky |
| CharCounter | 78 | B+ | Build Later | Strong QoL, moderate priority | Adds a Character Counter to most Inputs (Settings toggle) |
| ClickableMentions | 78 | B+(setting) | Build Later | Strong QoL, moderate priority | Allows you to open a User Popout by clicking a Mention in your Message Input |
| CompleteTimestamps | 78 | B | Build Later+(setting) | Strong QoL, moderate priority | Replaces Timestamps with your own custom Timestamps |
| CustomStatusPresets | 78 | B | Build Later | Strong QoL, moderate priority | Allows you to save Custom Statuses as Quick Select and select them by right-clicking the Status Bubble |
| FriendNotifications | 78 | B | Build Later(Definite addon) | Strong QoL, moderate priority | Shows a Notification when a Friend or a User, you choose to observe, changes their Status |
| HideMutedCategories | 78 | B+ | Build Later | Strong QoL, moderate priority | Hides muted Categories, if muted Channels are hidden |
| LastMessageDate | 78 | B(reminder Wabi is set to delete automatically so you should be aware of the persistence of the local app with the sidecar file) | Build Later | Strong QoL, moderate priority | Displays the Last Message Date of a Member for the current Server/DM in the UserPopout and UserModal |
| PersonalPins | 78 | B | Build Later+ | Strong QoL, moderate priority | Allows you to locally pin Messages |
| QuickMention | 78 | B | Build Later+ | Strong QoL, moderate priority | Adds a Mention Button to the Message 3-Dot Menu |
| ReadAllNotificationsButton | 78 | B | Build Later+ (Server list not made, auto min priority) | Strong QoL, moderate priority | Adds a Clear Button to the Server List and the Mentions Popout |
| RevealAllSpoilers | 78 | B | Build Later+(Needs to be blockable by role) | Strong QoL, moderate priority | Allows you to reveal all Spoilers within a Message/Status by holding the Ctrl Key and clicking a Spoiler |
| ServerFolders | 78 | B | Build Later(No servers list yet min priority) | Strong QoL, moderate priority | Changes Discord's Folders, Servers open in a new Container, also adds extra Features to more easily organize, customize and manage your Folders |
| ShowConnections | 78 | B | Build Later+ | Strong QoL, moderate priority | Shows the connected Accounts of a User in the UserPopout |
| UserNotes | 78 | B | Build Later+(Read small note) | Strong QoL, moderate priority | Allows you to write User Notes locally (We have this, cross compare)|
| BetterNsfwTag | 62 | C+(weak) | Backlog | Useful but niche/contextual | Adds a more noticeable Tag to NSFW Channels(Maybe customizable image instead of a simple NSFW tag?) |
| DisplayServersAsChannels | 62 | C+ | Backlog | Useful but niche/contextual | Displays Servers in a similar way as Channels(Might be how servers are in wabi) |
| EmojiStatistics | 62 | C(maybe core) | Backlog | Useful but niche/contextual | Shows you an Overview of Emojis and Emoji Servers |
| GameActivityToggle | 62 | C(Will not add to wabi) | Backlog | Useful but niche/contextual | Adds a Quick-Toggle Game Activity Button |
| GoogleSearchReplace | 62 | C(You can search in discord? needs research but absolute +) | Backlog | Useful but niche/contextual | Replaces the default Google Text Search with a custom Search Engine |
| RemoveBlockedUsers | 62 | C(? we sort of do this already. needs analysis) | Backlog | Useful but niche/contextual | Removes blocked/ignored Messages/Users |
| RemoveNicknames | 62 | C+(settings) | Backlog | Useful but niche/contextual | Replaces Nicknames with Accountnames |
| ServerCounter | 62 | C | Backlog | Useful but niche/contextual | Adds a Server Counter to the Server List |
| ServerDetails | 62 | C | Backlog+ | Useful but niche/contextual | Shows Server Details in the Server List Tooltip |
| ShowBadgesInChat | 62 | C | Backlog- | Useful but niche/contextual | Displays Badges (Nitro, Hypesquad, etc...) in the Chat/MemberList/DMList |
| SpotifyControls | 62 | C | Backlog(Spotify Addon) | Useful but niche/contextual | Adds a Control Panel while listening to Spotify on a connected Account |
| StaffTag | 62 | C | Backlog | Useful but niche/contextual (in, cross reference) | Adds a Crown/Tag to Server Owners (or Admins/Management) |
| TimedLightDarkMode | 62 | C | Backlog | Useful but niche/contextual+ | Adds a Time Slider to the Appearance Settings |
| TopRoleEverywhere | 62 | C | Backlog | Useful but niche/contextual | Adds the highest Role of a User as a Tag |
| WriteUpperCase | 62 | C | Backlog | Useful but niche/contextual | Changes the first Letter of each Sentence in Message Inputs to Uppercase |
| EditChannels | 46 | D (we sort of have?) | Skip unless requested | Low transfer value to Wabi | Allows you to locally edit Channels |
| EditRoles | 46 | D | Skip unless requested | Low transfer value to Wabi | Allows you to locally edit Roles |
| EditServers | 46 | D | Skip unless requested | Low transfer value to Wabi | Allows you to locally edit Servers |
| EditUsers | 46 | D | Skip unless requested | Low transfer value to Wabi | Allows you to locally edit Users |
| OpenSteamLinksInApp | 46 | D | Skip unless requested | Low transfer value to Wabi | Opens Steam Links in Steam instead of your Browser |
| ServerHider | 46 | D | Skip unless requested | Low transfer value to Wabi | Allows you to hide certain Servers in your Server List |
| OldTitleBar | 25 | F | Skip | Not relevant for Wabi architecture | Allows you to switch to Discord's old Titlebar |
