import type { Channel, Message, User } from "../socket-types";
export const scenes = [
  ["reset", "Reset demo community"],
  ["morning", "Morning activity"],
  ["evening", "Busy evening"],
  ["voice", "Voice event"],
  ["project", "Project workspace"],
  ["forum", "Forum discussion"],
] as const;
export type Scene = (typeof scenes)[number][0];
export function sceneFrom(value: string | null): Scene {
  return scenes.find(([id]) => id === value)?.[0] ?? "morning";
}
export function sceneTime(scene: Scene): number {
  return Date.parse(
    `2026-09-21T${scene === "evening" || scene === "voice" ? "19" : "09"}:42:00+07:00`,
  );
}
const names = [
  "Mira",
  "Theo Park",
  "Nora Ellis",
  "Jun Sato",
  "Amara Okafor",
  "Leo Martin",
  "Sofia Reyes",
  "Iris Wong",
];
const colors = [
  "#98d8c8",
  "#edba89",
  "#c0b0e8",
  "#9bbddb",
  "#e5a9ad",
  "#bdd19b",
  "#dfc98f",
  "#a7c8cf",
];
export const people: User[] = names.map((username, i) => ({
  id: `user-${9101 + i}`,
  dbUserId: 9101 + i,
  username,
  handle: username.split(" ")[0].toLowerCase(),
  color: colors[i],
  status: i === 6 ? "away" : "active",
  highestRole: i === 0 ? "admin" : "member",
  isRegistered: true,
  bio: [
    "Making room for good ideas.",
    "Designer, cyclist, enthusiastic note taker.",
    "Collecting stories and little discoveries.",
  ][i % 3],
  profilePicture: `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="30" fill="${colors[i]}"/><text x="48" y="61" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="600" fill="#263833">${username
      .split(" ")
      .map((n) => n[0])
      .join("")}</text></svg>`,
  )}`,
}));
export function community(now: number): Channel[] {
  return [
    ...[
      "general",
      "introductions",
      "small-discoveries",
      "field-notes",
      "weekend-plans",
    ].map((name, i) => ({
      id: name,
      name,
      type: "text" as const,
      createdAt: now - 86400000 * 30,
      position: i,
      minRole: "guest",
      description:
        i === 0
          ? "A little conversation. A few good ideas. A place to belong."
          : "Share what you are working on and what caught your eye.",
    })),
    {
      id: "studio-lounge",
      name: "Studio lounge",
      type: "voice",
      createdAt: now,
      description: "Monday gathering · bring something you made",
    },
    {
      id: "quiet-coworking",
      name: "Quiet coworking",
      type: "voice",
      createdAt: now,
    },
    {
      id: "listening-room",
      name: "Listening room",
      type: "voice",
      createdAt: now,
    },
    {
      id: "ideas-and-questions",
      name: "conversations",
      type: "forum",
      createdAt: now,
      description:
        "Longer conversations, shared questions, and ideas worth keeping.",
    },
    {
      id: "community-guide",
      name: "community-guide",
      type: "wiki",
      createdAt: now,
    },
    {
      id: "dm-showcase-theo",
      name: "Theo Park",
      type: "dm",
      createdAt: now,
      members: [people[0].id, people[1].id],
      otherUser: people[1],
      memberUsers: [people[0], people[1]],
    },
  ];
}
export function messages(scene: Scene, now: number): Record<string, Message[]> {
  const morning: [number, string][] = [
    [
      1,
      "Morning, everyone ☀️ The light in the studio is particularly good today.",
    ],
    [
      2,
      "A small discovery from the weekend: the bookshop on Cedar Street has a whole shelf of independent field guides.",
    ],
    [
      0,
      "That feels like research for our next little project. What if we made a guide to the places we keep coming back to?",
    ],
    [
      4,
      "Yes! Not the best places. Our places. The bench with the afternoon sun, the bakery that remembers your order.",
    ],
    [3, "I can draw a simple map. Something you can fold up and carry."],
    [
      1,
      "Added a few first steps to the project board. Nothing too big — one page from each of us to start.",
    ],
    [0, "A field guide to belonging. I like that. 🌿"],
    [
      2,
      "I’ll bring the bookshop story to tonight’s studio gathering. See you at seven!",
    ],
  ];
  const evening: [number, string][] = [
    [
      4,
      "The first pages are coming together! I love how different everyone’s versions of the neighborhood feel.",
    ],
    [
      3,
      "Mine is mostly trees and places to sit. This is probably very revealing.",
    ],
    [
      5,
      "Mine is mostly places to eat, so we have a complete guide between us.",
    ],
    [
      6,
      "Just finished the cover sketch. Warm paper, green ink, a tiny hand-drawn compass.",
    ],
    [
      0,
      "That sounds lovely. Can you bring it to the lounge? We’re looking at the first round together.",
    ],
    [
      1,
      "I moved the ready pages across on the board. Three finished, a few still brewing.",
    ],
    [7, "Joining in a minute — making tea first. 🫖"],
    [
      2,
      "The bookshop owner said we can leave a few copies by the door when it’s ready.",
    ],
    [
      4,
      "A little project finding its way into the world. That made my evening.",
    ],
  ];
  const make = (rows: [number, string][], prefix: string): Message[] =>
    rows.map(([who, text], i) => ({
      id: `${prefix}-${i}`,
      user: people[who].username,
      userId: people[who].id,
      senderStableId: people[who].id,
      color: people[who].color,
      text,
      type: "text",
      timestamp: now - (rows.length - i) * 180000,
      ...(i === 3
        ? { reactions: { "🌿": [people[0].id, people[2].id, people[5].id] } }
        : {}),
    }));
  return {
    general: make(
      scene === "evening" || scene === "voice" ? evening : morning,
      "general",
    ),
    "field-notes": make(
      [
        [2, "A field guide to belonging"],
        [0, "One familiar place. One story. A page worth keeping."],
        [
          1,
          "The first edition is on the board. Pick a small piece and make it yours.",
        ],
      ],
      "field",
    ),
    "dm-showcase-theo": make(
      [
        [
          1,
          "I put together a first outline for the field guide. Want to take a look before tonight?",
        ],
        [
          0,
          "Of course. I like the idea of keeping it small enough to finish together.",
        ],
        [
          1,
          "Exactly. Eight stories, a fold-out map, and a little space for someone to add their own favorite place.",
        ],
        [
          0,
          "Let’s leave the last page blank. An invitation, rather than an ending.",
        ],
      ],
      "dm",
    ),
  };
}
export function forumPosts(now: number) {
  const titles = [
    "What makes a place feel like yours?",
    "A small field guide, made together",
    "What are you reading this month?",
    "Ideas for our next studio evening",
  ];
  const bodies = [
    "I have been thinking about the places we return to without really deciding to. A bench, a bookshop, a familiar walk home.\n\nFor our field guide, I would love to collect the tiny details that turn a location into a place you belong. What is yours?",
    "Eight stories, a map, and room for one more. Share a place you would like to contribute to our first community field guide.",
    "A book, a poem, an article you are still thinking about. Leave a recommendation and tell us what stayed with you.",
    "We have tried sketching, reading, and quiet coworking. What would you like to make space for next?",
  ];
  const post = (
    id: string,
    thread: string,
    who: number,
    body: string,
    title = "",
    index = 0,
  ) => ({
    post_id: id,
    thread_id: thread,
    channel_id: "ideas-and-questions",
    author_user_id: 9101 + who,
    title,
    body,
    created_at_micros: (now - 3600000 * (8 - index)) * 1000,
    is_deleted: false,
    is_thread_starter: id === thread,
    tags: id === thread ? ["Discussion"] : [],
    votes_up: id === thread ? 7 - index : 2,
    votes_down: 0,
    is_solution: false,
    category: "Discussion",
  });
  const threads = titles.map((title, i) =>
    post(
      `showcase-thread-${i}`,
      `showcase-thread-${i}`,
      i,
      bodies[i],
      title,
      i,
    ),
  );
  return {
    threads,
    posts: [
      threads[0],
      post(
        "showcase-reply-1",
        threads[0].thread_id,
        4,
        "The bakery on the corner. They start setting aside my usual loaf when they see my bike outside. It is a very small kind of being known.",
        "",
        5,
      ),
      post(
        "showcase-reply-2",
        threads[0].thread_id,
        3,
        "There is a tree on my walk home that turns gold before all the others. Every autumn it feels like a message meant for me.",
        "",
        6,
      ),
      post(
        "showcase-reply-3",
        threads[0].thread_id,
        0,
        "These are exactly the stories I hoped we would find. Let’s put the small details on the map, too.",
        "",
        7,
      ),
    ],
  };
}
