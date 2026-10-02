import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const origin = "http://127.0.0.1:5196";
const output = resolve(process.argv[2] || "showcase-artifacts");
const scenes = ["reset", "morning", "evening", "voice", "project", "forum"];
const viewports = [
  { width: 1536, height: 960 },
  { width: 1000, height: 900 },
];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let browser;
await mkdir(output, { recursive: true });
try {
  try {
    await fetch(`${origin}/showcase`);
  } catch {
    server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "5196",
        "--strictPort",
      ],
      { env: { ...process.env, VITE_WABI_SHOWCASE: "1" }, stdio: "ignore" },
    );
    let listening = false;
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${origin}/showcase`);
        listening = true;
        break;
      } catch {
        await delay(200);
      }
    }
    assert(listening, "Showcase server did not start.");
  }
  browser = process.env.SHOWCASE_CDP
    ? await chromium.connectOverCDP(process.env.SHOWCASE_CDP)
    : await chromium.launch({ headless: false, args: ["--disable-gpu"] });
  const manifest = {
    origin,
    timezone: "Asia/Bangkok",
    locale: "en-US",
    browser: browser.version(),
    fixtureVersion: 1,
    screenshots: [],
    checks: [],
  };
  async function openScene(scene, viewport) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      timezoneId: manifest.timezone,
      locale: manifest.locale,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin)
        external.push(r.url());
    });
    await page.goto(`${origin}/showcase?scene=${scene}`);
    await page
      .locator('[data-showcase-ready="true"]')
      .waitFor({ state: "attached", timeout: 60000 });
    if (scene === "forum")
      await page
        .locator(".forum-post-detail-title")
        .filter({ hasText: "What makes a place feel like yours?" })
        .waitFor();
    if (scene === "project")
      await page
        .getByText("Draw the neighborhood map", { exact: true })
        .waitFor();
    if (scene === "voice")
      await page.getByText("8 in call", { exact: true }).waitFor();
    if (["reset", "morning"].includes(scene))
      await page
        .getByText("A field guide to belonging. I like that.")
        .waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.images].map((img) => img.decode().catch(() => {})),
      );
    });
    await page.keyboard.press("Control+Shift+s");
    await page.mouse.move(600, 0);
    await page.waitForTimeout(900);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `${scene}: page overflows viewport`,
    );
    assert.deepEqual(errors, [], `${scene}: browser errors`);
    assert.deepEqual(external, [], `${scene}: external requests`);
    return { context, page, errors, external };
  }
  for (const viewport of viewports)
    for (const scene of scenes) {
      const { context, page } = await openScene(scene, viewport);
      const file = `${scene}-${viewport.width}.png`;
      const first = await page.screenshot({
        path: resolve(output, file),
        animations: "disabled",
        caret: "hide",
      });
      await context.close();
      const repeat = await openScene(scene, viewport);
      const second = await repeat.page.screenshot({
        animations: "disabled",
        caret: "hide",
      });
      const difference = first.equals(second)
        ? { pixels: 0, maxChannelDelta: 0 }
        : await repeat.page.evaluate(
            async ([a, b]) => {
              async function pixels(encoded) {
                const image = new Image();
                image.src = `data:image/png;base64,${encoded}`;
                await image.decode();
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d");
                context.drawImage(image, 0, 0);
                return context.getImageData(0, 0, canvas.width, canvas.height)
                  .data;
              }
              const left = await pixels(a),
                right = await pixels(b);
              let count = 0,
                max = 0;
              for (let i = 0; i < left.length; i += 4) {
                let changed = false;
                for (let c = 0; c < 4; c++) {
                  const delta = Math.abs(left[i + c] - right[i + c]);
                  if (delta) changed = true;
                  max = Math.max(max, delta);
                }
                if (changed) count++;
              }
              return { pixels: count, maxChannelDelta: max };
            },
            [first.toString("base64"), second.toString("base64")],
          );
      await repeat.context.close();
      // Chromium GPU rasterization can round scaled images and border pixels by a few color levels.
      const stable =
        difference.maxChannelDelta <= 4 &&
        difference.pixels <= viewport.width * viewport.height * 0.0005;
      if (!stable)
        await writeFile(
          resolve(output, `${scene}-${viewport.width}-repeat.png`),
          second,
        );
      assert(
        stable,
        `${scene}-${viewport.width}: repeated capture differs (${JSON.stringify(difference)})`,
      );
      manifest.screenshots.push({
        scene,
        ...viewport,
        file,
        sha256: createHash("sha256").update(first).digest("hex"),
        repeatIdentical: first.equals(second),
        rasterDifference: difference,
      });
      console.log(
        `Captured ${file} · repeat stable (${difference.pixels} rounding pixels)`,
      );
    }
  // Reset must discard edits, restore layout, and leave unrelated local keys intact.
  const { context, page } = await openScene("evening", viewports[0]);
  await page.evaluate(async () => {
    localStorage.setItem("showcase-test-unrelated", "keep");
    const load = (path) => {
      // Use the mounted module, including Vite's HMR revision. Importing an
      // unversioned path can create a second, empty store after a hot update.
      const loaded = performance
        .getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === path);
      return import(loaded?.name ?? path);
    };

    const { channelMessages } = await load("/src/lib/messageStore.ts");
    channelMessages.set({ general: [] });
    const { todos } = await load("/src/lib/business/state.ts");
    todos.set([]);
    const { layoutStore } = await load("/src/lib/layoutStore.ts");
    layoutStore.setStubSide("left");
  });
  await page.keyboard.press("Control+Shift+s");
  await page.getByRole("button", { name: "Showcase", exact: false }).click();
  await Promise.all([
    page.waitForURL("**/showcase?scene=reset"),
    page
      .getByRole("link", { name: "Reset demo community", exact: true })
      .click(),
  ]);
  await page
    .locator('[data-showcase-ready="true"]')
    .waitFor({ state: "attached" });
  const reset = await page.evaluate(async () => {
    const load = (path) => {
      // Use the mounted module, including Vite's HMR revision. Importing an
      // unversioned path can create a second, empty store after a hot update.
      const loaded = performance
        .getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === path);
      return import(loaded?.name ?? path);
    };
    const get = (store) => {
      let result;
      store.subscribe((value) => (result = value))();
      return result;
    };
    const { channelMessages } = await load("/src/lib/messageStore.ts");
    const { todos } = await load("/src/lib/business/state.ts");
    const { stubSide } = await load("/src/lib/layoutStoreStates.ts");
    return {
      messages: get(channelMessages).general.length,
      tasks: get(todos).length,
      side: get(stubSide),
      unrelated: localStorage.getItem("showcase-test-unrelated"),
    };
  });
  assert.deepEqual(reset, {
    messages: 8,
    tasks: 10,
    side: "right",
    unrelated: "keep",
  });
  manifest.checks.push(
    "Reset restores chat, Planner and right stubs without clearing unrelated storage.",
  );
  const boundary = await page.evaluate(async () => {
    const api = await fetch("https://example.com/api/delete", {
      method: "POST",
    });
    let external = false,
      ws = false,
      media = false;
    try {
      await fetch("https://example.com/leak");
    } catch {
      external = true;
    }
    try {
      new WebSocket("wss://example.com");
    } catch {
      ws = true;
    }
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      media = true;
    }
    return { api: api.status, external, ws, media };
  });
  assert.deepEqual(boundary, {
    api: 501,
    external: true,
    ws: true,
    media: true,
  });
  manifest.checks.push(
    "API writes are local failures; external fetch, sockets and microphone acquisition are blocked.",
  );
  await context.close();
  await writeFile(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const labels = {
    reset: "Reset demo community",
    morning: "Morning activity",
    evening: "Busy evening",
    voice: "Voice event",
    project: "Project workspace",
    forum: "Forum discussion",
  };
  const cards = manifest.screenshots
    .map(
      (s) =>
        `<article><h2>${labels[s.scene]} <small>${s.width} × ${s.height}</small></h2><a href="${s.file}"><img src="${s.file}" alt="${labels[s.scene]} at ${s.width} pixels" loading="lazy"></a></article>`,
    )
    .join("\n");
  await writeFile(
    resolve(output, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wabi — Common Ground showcase</title><style>body{margin:0;background:#0d1020;color:#ecebf6;font:16px/1.6 system-ui}main{max-width:1440px;margin:auto;padding:32px}h1{font-size:36px;letter-spacing:-.04em;margin:0}p{color:#b2b5ca;max-width:760px}article{margin:40px 0}h2{font-size:18px}small{font-size:13px;font-weight:400;color:#a5aac1;margin-left:12px}img{width:100%;display:block;border:1px solid #30344c;border-radius:12px}a{color:#bca7ff}</style><main><h1>Wabi · Common Ground</h1><p>A reproducible demo community: eight people making a field guide to the places they love. Every screen is Wabi’s real interface, populated with fictional local fixtures. Voice scenes simulate participants; no media connection is made.</p><p>Six scenes · two desktop widths · repeated captures verified stable. <a href="manifest.json">Capture manifest</a></p>${cards}</main></html>`,
  );
  console.log(`Gallery: ${resolve(output, "index.html")}`);
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
