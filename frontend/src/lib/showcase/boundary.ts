import { isShowcaseMode } from "./mode";
import { forumPosts, people, sceneFrom, sceneTime } from "./fixtures";
/** Installed before layouts mount. Unsupported API operations fail locally. */
export function installShowcaseBoundary(): void {
  if (!isShowcaseMode()) return;
  const now = sceneTime(
    sceneFrom(new URL(location.href).searchParams.get("scene")),
  );
  const NativeDate = Date;
  window.Date = new Proxy(NativeDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [now]);
    },
    apply() {
      return new NativeDate(now).toString();
    },
    get(target, key) {
      return key === "now" ? () => now : Reflect.get(target, key);
    },
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (url.pathname.startsWith("/api/")) {
      const forum = forumPosts(now);
      let data: unknown;
      if (/\/api\/channels\/[^/]+\/join$/.test(url.pathname))
        data = { joined: true, channelId: url.pathname.split("/")[3] };
      else if (/\/api\/forum\/[^/]+\/threads$/.test(url.pathname))
        data = { threads: forum.threads };
      else if (
        /\/api\/forum\/[^/]+\/threads\/[^/]+\/posts$/.test(url.pathname)
      ) {
        const id = url.pathname.split("/")[5];
        data = {
          posts:
            id === "showcase-thread-0"
              ? forum.posts
              : forum.threads.filter((p) => p.thread_id === id),
        };
      } else if (/\/api\/users/.test(url.pathname))
        data = {
          users: people.map((p) => ({
            user_id: p.dbUserId,
            username: p.username,
            profile_picture: p.profilePicture,
            color: p.color,
          })),
        };
      else if (/\/api\/wiki\/[^/]+\/pages$/.test(url.pathname))
        data = {
          pages: [
            {
              pageId: "showcase-guide",
              channelId: "community-guide",
              title: "Welcome to our little corner",
              body: "# A place to make things together\n\nStart with a conversation in **general**, share a small discovery, or join us in the studio lounge.\n\n## Our field guide\n\nWe are collecting the places that make our neighborhood feel like home. One page, one story, one familiar place.\n\n## Weekly rhythm\n\n- Monday: studio gathering\n- Wednesday: quiet coworking\n- Weekend: a walk and a few field notes",
              authorUserId: 9101,
              createdAtMicros: now * 1000,
              updatedAtMicros: now * 1000,
              isDeleted: false,
              parentPageId: "",
              slug: "welcome",
              orderIndex: 0,
            },
          ],
        };
      else if (/\/revisions$/.test(url.pathname)) data = { revisions: [] };
      else
        return Response.json(
          { error: "This action is unavailable in the isolated showcase." },
          { status: 501 },
        );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" && !url.pathname.endsWith("/join"))
        return Response.json(
          { error: "Showcase content is reset from fixtures." },
          { status: 405 },
        );
      return Response.json(data);
    }
    if (
      url.origin !== location.origin &&
      url.protocol !== "data:" &&
      url.protocol !== "blob:"
    )
      throw new TypeError("Showcase blocks external requests.");
    return nativeFetch(input, init);
  }) as typeof window.fetch;
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args) {
      const url = new URL(String(args[0]), location.href);
      if (url.host !== location.host || args[1] !== "vite-hmr")
        throw new Error("Showcase has no live socket transport.");
      return Reflect.construct(target, args);
    },
  });
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args: any[]) {
    const url = new URL(String(args[1]), location.href);
    if (url.origin !== location.origin || url.pathname.startsWith("/api/"))
      throw new Error("Showcase blocks XHR API requests.");
    return (open as any).apply(this, args);
  };
  window.EventSource = new Proxy(window.EventSource, {
    construct() {
      throw new Error("Showcase blocks event streams.");
    },
  });
  navigator.sendBeacon = () => false;
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Simulated participants only.", "NotAllowedError");
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      throw new DOMException(
        "Showcase does not capture screens.",
        "NotAllowedError",
      );
    };
  }
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct() {
      throw new Error("Showcase has no peer transport.");
    },
  });
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content =
    "connect-src 'self' ws://127.0.0.1:5196; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'; form-action 'none'";
  document.head.append(csp);
}
