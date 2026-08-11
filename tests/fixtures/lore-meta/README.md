# Wabi-on-Wabi Lore Fixture

This small repository is the smoke-test fixture for Wabi's Lore integration.

It exercises:

- native repository initialization;
- code and prose files;
- image preview;
- file/path search;
- later revision and review comparisons.

The fixture is intentionally boring: if the boring path fails, the product path is not ready.

## Test flow

1. Browse this file in Files.
2. Open `src/hello.rs` in Code.
3. Search for `hello` across all spaces.
4. Open `assets/test.svg` as artwork.
5. Add a later revision and compare it with this initial revision.

Initial fixture revision.

## Revision marker

- fixture: initial
- expected channel: Lore test channel
- expected repo class: native
