# Scoped `<style>` bare-scan gate

Use after tokenizing a single large Svelte component `<style>` block (e.g. LoreChannel L6) when you need a hard zero on bare colors/z-index **outside** token functions.

Also useful for any Wabi component polish card that claims "no bare hex left."

## Goal

Zero of:
- bare `#hex` not inside `var(...)` or `color-mix(...)`
- bare `rgba(...)` / `rgb(...)` not inside those functions
- raw `z-index: <digits>` (must be `var(--z-*)` or `calc(var(--z-*) + N)`)

`var(--token, #fallback)` is **OK** — fallbacks are not bare failures. Strip the whole `var(...)` before counting.

## Preferred token targets (Wabi)

| Bare | Prefer |
|------|--------|
| `z-index: 2000` / `2001` | `var(--z-lightbox)` / `calc(var(--z-lightbox) + 1)` — use **final** tokens.css value (legacy block last-wins; lightbox may be 12000) |
| `#fff` on danger/success chips | `var(--text-on-danger)` or `var(--text-on-success)` |
| `#a33` / `#ff4444` / soft red wash | `var(--color-danger)` / `var(--text-danger)` / `var(--color-danger-bg)` |
| `#2d7d46` | `var(--color-success)` |
| `#854d0e` | `var(--color-warning)` |
| `rgba(0,0,0,0.6)` overlays | `var(--surface-overlay)` |
| white washes `rgba(255,255,255,0.0N)` | `color-mix(in srgb, var(--text-heading) N%, transparent)` |
| black scrims in gradients | `color-mix(in srgb, #000 N%, transparent)` — `#000` only **inside** color-mix is allowed if scan strips color-mix |

## Python bare-scan (copy/run)

```python
from pathlib import Path
import re

text = Path("frontend/src/lib/components/LoreChannel.svelte").read_text()
css = re.search(r"<style>(.*?)</style>", text, re.S).group(1)
bare = []
for i, line in enumerate(css.splitlines(), 1):
    s = line.strip()
    if not s or s.startswith("/*"):
        continue
    if re.search(r"z-index:\s*\d+", line):
        bare.append((i, s, "z"))
        continue
    tmp = line
    # strip var(...) and color-mix(...) with nested parens
    for fn in ("var(", "color-mix("):
        while fn in tmp:
            start = tmp.find(fn)
            depth, j = 1, start + len(fn)
            while j < len(tmp) and depth:
                if tmp[j] == "(": depth += 1
                elif tmp[j] == ")": depth -= 1
                j += 1
            tmp = tmp[:start] + tmp[j:]
    if re.search(r"#[0-9a-fA-F]{3,8}", tmp):
        bare.append((i, s, "hex"))
    if re.search(r"rgba?\(", tmp):
        bare.append((i, s, "rgba"))
print("bare count", len(bare))
for row in bare:
    print(row)
```

Gate: `bare count 0` before marking the tokenize card done. Still run `bun run check` — compile baseline is separate from bare-scan.

## Pitfalls

- Do not invent new z numbers; read **last-wins** `--z-*` from tokens.css.
- `#000` / `#fff` inside `color-mix` will false-positive if you only strip `var(`.
- Order of hex replace: long hex before short (`#fff` last) to avoid mid-token corruption.
- Tokenize is not a full Pass 0–5 AGENTS.md polish — scope to the card (one component) unless the user opened a polish wave.
- L6 notes for Lore = header `layoutStore.openNotes()` only; not N1–N4 rewrite.
