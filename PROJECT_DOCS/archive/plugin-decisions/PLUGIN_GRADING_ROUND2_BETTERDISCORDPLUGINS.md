# Plugin Grading (Round 2)

Source scanned: `C:\Users\Willp\Documents\GitHub\BetterDiscordPlugins-main`

Scope: focused grading for the six-plugin set (`GifCaptioner`, `ImageFolder`, `MoreQuickReacts`, `UnicodeEmojis`, `VideoCompressor`, `ZipPreview`).
Scoring model: weighted rubric from `PLUGIN_PORTING_MASTER_PLAN.md`.

| Plugin | Impact | Frequency | Differentiation | Effort | Risk | Score | Grade | Track | Decision | Notes |
|---|---:|---:|---:|---:|---:|---:|:---:|---|---|---|
| ZipPreview+++ | 5 | 4 | 5 | 3 | 3 | 87 | A+ | Core | Build Early | Strong trust/safety UX win on attachment-heavy chats. |
| ImageFolder+++ | 5 | 4 | 4 | 4 | 3 | 81 | B+ | Core | Build After P0 | High utility, deeper picker/upload integration, and now tied to approved shared albums. |
| VideoCompressor+++ | 5 | 4 | 4 | 4 | 4 | 79 | B+ | Core | Build Next | High value for upload limits; higher runtime/perf risk needs phased rollout. |
| MoreQuickReacts+ | 3 | 4 | 2 | 2 | 1 | 67 | C+ | Core | Backlog | Nice QoL, lower strategic impact but still core per `+` routing rule. |
| GifCaptioner | 3 | 2 | 4 | 4 | 3 | 57 | C | Addon | Backlog | Fun feature, but heavier media pipeline complexity. |
| UnicodeEmojis- | 2 | 2 | 2 | 2 | 2 | 48 | D | Addon | Skip Unless Requested | Niche behavior with compatibility downsides. |

## Formula
`Score = (Impact*0.35 + Frequency*0.25 + Differentiation*0.20 + (6-Effort)*0.10 + (6-Risk)*0.10) * 20`

## Recommendation
1. Keep `ZipPreview` and `VideoCompressor` as the immediate implementation pair.
2. Treat `ImageFolder` as core and fold it into the shared media albums roadmap.
3. Run `VideoCompressor` as a phased feature flag because encode paths can impact CPU/battery.
4. Defer non-core addons until attachment/media roadmap items are stable.
