import { get } from "svelte/store";
import { isShowcaseMode } from "./mode";
import { community, messages, people, sceneTime, type Scene } from "./fixtures";
export async function prepareScene(scene: Scene): Promise<void> {
  if (!isShowcaseMode())
    throw new Error(
      "Showcase requires the dedicated local development server.",
    );
  const now = sceneTime(scene);
  const { themeStore } = await import("../theme/themeStore");
  themeStore.reset();
  const { applyTheme } = await import("../theme/themeManager");
  const { darkTheme } = await import("../theme/themes");
  applyTheme(darkTheme);
  document.documentElement.style.setProperty("--bg-effect-effect", "none");
  const { setConfiguredServerUrl } = await import("../serverUrl");
  setConfiguredServerUrl(location.origin, false);
  const auth = await import("../authSession");
  auth.setStoredDbUserId(9101, location.origin);
  auth.setStoredUsername(people[0].username, location.origin);
  auth.setAuthToken("showcase-local-fixture-not-a-credential", location.origin);
  const { recordSuccessfulServerConnection, renameLocalSavedServer } =
    await import("../savedServers");
  recordSuccessfulServerConnection({
    url: location.origin,
    username: people[0].username,
  });
  renameLocalSavedServer(location.origin, "Common Ground");
  const { LocalMockSocket } = await import("../localMockSocket");
  const connection = await import("../socketConnectionState");
  connection.socket.set(new LocalMockSocket(people[0].username) as any);
  connection.connected.set(true);
  connection.connectionState.set("connected");
  const presence = await import("../presenceStore");
  presence._setCurrentUser(people[0]);
  presence._setUsers(people);
  presence._setServerMembers(people);
  const channels = await import("../channelStore");
  channels.channels.set(community(now));
  channels.currentChannel.set(
    scene === "forum" ? "ideas-and-questions" : "general",
  );
  channels._updatePinnedChannels();
  const chat = await import("../messageStore");
  chat.channelMessages.set(messages(scene, now));
  chat.channelUnreadCounts.set(
    scene === "evening"
      ? { "small-discoveries": 3, "dm-showcase-theo": 2 }
      : {},
  );
  chat.unreadCount.set(scene === "evening" ? 5 : 0);
  const { layoutStore: layout } = await import("../layoutStore");
  await layout.resetAllLayouts();
  layout.closeRightPanel();
  layout.setStubSide("right");
  layout.resetStubs();
  const shell = await import("../layoutStoreStates");
  shell.homeLayout.set("server-browser");
  shell.channelSidebarWidth.set(280);
  shell.focusMode.set(false);
  const storage = await import("../business/deviceStorage");
  storage.reloadFromStorage();
  for (let i = 0; i < 100 && !get(storage.plannerStorage).loaded; i++)
    await new Promise((r) => setTimeout(r, 20));
  if (!get(storage.plannerStorage).loaded)
    throw new Error(
      "Demo Planner could not initialize its separate local notebook.",
    );
  const { applyBusinessDataSnapshot } = await import("../business/snapshot");
  const { DEFAULT_KANBAN_COLUMNS } = await import("../business/state");
  const tasks = [
    [
      "ideas",
      "Collect the places we return to",
      "A bench, a bakery, a familiar way home.",
    ],
    [
      "ideas",
      "Leave room for one more story",
      "An invitation on the last page.",
    ],
    [
      "todo",
      "Choose paper and a green ink",
      "Try a small print sample at the studio.",
    ],
    [
      "todo",
      "Write a note to our readers",
      "Keep it warm, simple, and personal.",
    ],
    [
      "in_progress",
      "Draw the neighborhood map",
      "Jun is mapping the places in our first edition.",
    ],
    ["in_progress", "Gather eight little stories", "One page from each of us."],
    ["in_progress", "Sketch the cover", "A tiny compass and room to breathe."],
    ["done", "Find a name for the field guide", "A field guide to belonging."],
    [
      "done",
      "Set the first studio gathering",
      "Monday evening, tea encouraged.",
    ],
    [
      "done",
      "Visit the Cedar Street bookshop",
      "A home for a few copies when we are ready.",
    ],
  ] as const;
  applyBusinessDataSnapshot({
    todos: tasks.map(([status, title, description], i) => ({
      id: `showcase-task-${i}`,
      title,
      description,
      status,
      projectId: "showcase-project",
      priority: i === 4 ? "high" : "medium",
      createdAt: now - 86400000 * 3,
      updatedAt: now,
      createdBy: people[0].id,
      dueDate: now + 86400000 * ((i % 4) + 1),
    })),
    calendarEvents: [
      {
        id: "showcase-gathering",
        title: "Studio gathering · first pages",
        startDate: Date.parse("2026-09-21T19:00:00+07:00"),
        endDate: Date.parse("2026-09-21T20:00:00+07:00"),
        allDay: false,
        createdBy: people[0].id,
        color: "#98d8c8",
      },
    ],
    diaryEntries: [],
    projects: [
      {
        id: "showcase-project",
        name: "A field guide to belonging",
        description: "Eight stories, a fold-out map, and room for one more.",
        color: "#98d8c8",
        createdBy: people[0].id,
        createdAt: now - 86400000 * 3,
        status: "active",
      },
    ],
    sprints: [],
    resources: [],
    tags: [],
    graphEdges: [],
    kanbanColumns: structuredClone(DEFAULT_KANBAN_COLUMNS),
  });
  await storage.flushBusinessStorage();
  const { captureNotebookOwner } = await import("../notes/scope");
  const { LocalNotebook } = await import("../notes/db");
  const notebook = new LocalNotebook(await captureNotebookOwner());
  const scratch = await notebook.getScratchpad();
  await notebook.save(scratch.id, scratch.revision, {
    text: "Tonight · studio gathering\n\nBring one story and a first sketch.\n\nEight places. Eight pages.\nLeave the last page open.",
  });
  sessionStorage.setItem("plannerDeepLinkView", "board");
  const navigation = await import("../workspaceNavigationState");
  navigation.selectWorkspaceView(scene === "project" ? "planner" : "messages");
  if (innerWidth >= 1200 && (scene === "morning" || scene === "reset"))
    layout.pinPanel("users");
  if (scene === "forum")
    (await import("../pendingNav")).setPendingNav({
      kind: "forum_post",
      channelId: "ideas-and-questions",
      postId: "showcase-thread-0",
    });
  if (scene === "voice") {
    const participants = people.map((p, i) => ({
      userId: p.id,
      username: p.username,
      isSpeaking: i === 4,
      isMuted: i === 6,
      isListenOnly: i === 7,
    }));
    presence._setVoiceChannelMembers(
      "studio-lounge",
      participants.map((p) => ({
        ...p,
        isDeafened: false,
        profilePicture: people.find((u) => u.id === p.userId)?.profilePicture,
      })),
    );
    const { callSessionManager } = await import("../callSessionManager");
    callSessionManager.register({
      id: "studio-lounge",
      channelId: "studio-lounge",
      kind: "channel",
      name: "Studio lounge",
      direction: "listen",
      participants,
    });
    callSessionManager.markConnected("studio-lounge", null);
    navigation.selectWorkspaceView("voice");
    for (const [id, name, indices, volume] of [
      ["quiet-coworking", "Quiet coworking", [1, 3, 5], 35],
      ["listening-room", "Listening room", [2, 6, 7], 0],
    ] as const) {
      const members = indices.map((i) => participants[i]);
      presence._setVoiceChannelMembers(
        id,
        members.map((p) => ({
          ...p,
          isSpeaking: false,
          isDeafened: false,
          profilePicture: people.find((user) => user.id === p.userId)
            ?.profilePicture,
        })),
      );
      callSessionManager.register({
        id,
        channelId: id,
        kind: "channel",
        name,
        direction: "listen",
        volume,
        participants: members,
      });
      callSessionManager.markConnected(id, null);
    }
  }
}
