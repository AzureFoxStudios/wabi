# Live reference and gallery follow-up

The live Forum verification thread and reply were posted at the user's request. On the previously deployed build, bold, italic, literal code, Wiki page references, channel references and mention profile opening worked. The Gallery reference selected the gallery but failed to open the requested work. `All Works` showed the count but excluded the newest uploads from its grid, leaving small galleries empty.

Changes prepared:

- All matching gallery works remain visible, ordered into stable uploader groups with newest works first within each group. Existing creator filtering remains available for every uploader, including offline/unresolved identities.
- Gallery navigation subscribes to the pending target so a reference to an already loaded gallery opens its requested work.
- Shared object references display the content kind and title, retaining canonical copied syntax and literal code.
- Chat mention suggestions merge the full member directory with current presence, preserving offline members.
- Authenticated Lore file links select the project Files view and open the named file using existing permissions and preview loading.
- Opening share menus avoids focus-induced page scrolling.

Frontend check: zero errors, 121 existing warnings. Gallery/reference tests: 13 passed. Offline mention directory: one passed. Gallery lifecycle fixture passed in its isolated process (12 inner cases).

Final deployed static version: 1790928065702. Index SHA256: 660c692855418b596dc063bdd459e10682ca1101d0ff76a56461566b507c9dd0. Binary SHA256: edc7dd8d1685fa89676e4ddb5a5a5603cee9a2c22689ace6143df4b091b8994f. Backup: `/home/tim/wabi-backups/ui-20261002T081704Z`.

The final package passed disposable Authority startup/UI/version/health/ready and anonymous admin rejection checks. Live Tim readback verified the binary, embedded version and entry assets, all health routes, helper containers and preserved advisory lock inode6029360. Existing runtime Rust/Cargo inputs remained unchanged through compilation; geographic focused checkpoint verification separately passed7/0/1ignored against its earlier exact static/source freeze.

Real browser fixture acceptance confirmed full-width uploader headings, all recent works in All Works, creator filtering, exact work lightbox opening for a pending reference arriving after Gallery loaded, and readable Gallery/Forum/Wiki reference chips. Temporary fixture edits were restored; synthetic identities never deployed. Three isolated Lore deep-link tests passed for delayed authenticated channel loading, one-shot consumption, server-switch cancellation and traversal rejection.

The authenticated live Forum test thread and reply remain available in test-forum. Final update reload signed the browser out. Final authenticated live Gallery/Lore/mention checks remain pending user sign-in; local browser and regression results do not claim those live checks completed. The original unsent chat draft `@m` was preserved in browser automation state and was never sent.
