# Browser scripts

Run against a demo server (`npm run demo` in `sabi/`).

```sh
cd sabi/scripts/browser && npm install
node shot.mjs ../../docs/screenshots "01-today=/,02-jobs=/jobs"   # name=path[=full]
node flow.mjs                                                     # nok: customer → job → quotation → line → ⌘S → issue
```

`@sparticuz/chromium` ships a self-contained Chromium. On minimal Linux images that lack NSS, extract its
`bin/al2023.tar.br` and set `LD_LIBRARY_PATH` to the extracted `lib/` folder. `LOC=th` switches the UI language.
