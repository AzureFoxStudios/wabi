# Browser scripts

Run against a demo server (`npm run demo` in `sabi/`).

```sh
cd sabi/scripts/browser && npm install
node shot.mjs ../../docs/screenshots "01-today=/,02-jobs=/jobs"   # name=path[=full]
node flow.mjs                                                     # nok: customer → job → quotation → line → ⌘S → issue
```

`@sparticuz/chromium` ships a self-contained Chromium. On minimal Linux images that lack NSS, extract its
`bin/al2023.tar.br` and set `LD_LIBRARY_PATH` to the extracted `lib/` folder. `LOC=th` switches the UI language.

`node embed.mjs` is the worst-case embedding test. The app runs in a cross-site iframe, behind a proxy that strips
`Cookie`/`Authorization`/`Set-Cookie` and rewrites `Host`, with browser storage blocked (`STORAGE=ok` keeps storage).
It signs in, opens a job and creates a task only by clicking. Expects the demo server on :8080.
