import { describe, expect, test } from "bun:test";
import {
  community,
  forumPosts,
  messages,
  people,
  sceneFrom,
  sceneTime,
  scenes,
} from "./fixtures";

describe("reproducible showcase fixtures", () => {
  test("reset and morning restore the same community, independent of wall clock", () => {
    const now = sceneTime("morning");
    expect(now).toBe(Date.parse("2026-09-21T02:42:00Z"));
    expect(sceneTime("reset")).toBe(now);
    expect(messages("reset", now)).toEqual(messages("morning", now));
    expect(messages("morning", now)).toEqual(
      messages("morning", sceneTime("morning")),
    );
    expect(sceneTime("evening") - now).toBe(10 * 60 * 60 * 1000);
  });
  test("every message author and forum reply belongs to the seeded community", () => {
    const ids = new Set(people.map((p) => p.id));
    expect(ids.size).toBe(8);
    for (const [scene] of scenes)
      for (const rows of Object.values(messages(scene, sceneTime(scene)))) {
        expect(new Set(rows.map((m) => m.id)).size).toBe(rows.length);
        for (const message of rows) expect(ids.has(message.userId!)).toBe(true);
      }
    const { threads, posts } = forumPosts(sceneTime("forum"));
    expect(threads).toHaveLength(4);
    expect(posts.filter((p) => !p.is_thread_starter)).toHaveLength(3);
    for (const post of posts) {
      expect(threads.some((t) => t.thread_id === post.thread_id)).toBe(true);
      expect(people.some((p) => p.dbUserId === post.author_user_id)).toBe(true);
    }
  });
  test("scenes use real channel types and normalize unknown URL inputs", () => {
    const channels = community(sceneTime("reset"));
    expect(new Set(channels.map((c) => c.id)).size).toBe(channels.length);
    expect(channels.filter((c) => c.type === "voice")).toHaveLength(3);
    expect(channels.some((c) => c.type === "forum")).toBe(true);
    expect(channels.some((c) => c.type === "wiki")).toBe(true);
    expect(sceneFrom("not-a-scene")).toBe("morning");
    expect(sceneFrom(null)).toBe("morning");
  });
});
