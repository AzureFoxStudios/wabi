# Add-ons Bundle

This folder contains add-ons that are not installed by default.

- `addons/packages/`:
  packaged add-ons (`.wabi-plugin` / `.wabip`) for sharing and test installs.
- `addons/source/`:
  source folders for the bundled add-ons.

Wabi runtime loads installed add-ons only from `plugins/`.
That means this repo currently ships in an "uninstalled add-ons" state.

## Install an add-on locally

Copy one add-on source folder into `plugins/` and restart backend.

PowerShell example:

```powershell
Copy-Item -Recurse -Force addons/source/model-viewer plugins/model-viewer
```

Or use the helper script for test plugins:

```powershell
npm run plugin:install:test -- model-viewer
```

## Re-package/sign

Use the signing tools from repo root:

```bash
npm run plugin:keygen -- --out-dir .wabi-keys
npm run plugin:sign -- --plugin addons/source/model-viewer --private-key .wabi-keys/<key-id>.private.pem
npm run plugin:verify -- --plugin addons/source/model-viewer --strict
```
