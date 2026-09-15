# Build identity

**Candidate:** production-finish branch; publication and deployment are separate gates.

Use source revisions and artifact hashes when comparing an installed client/server with a PR. Client and server package versions are separate: a version number alone does not identify the shipped code.

## Inspect an installation

- **Settings → About** shows the compiled client version/revision and the currently selected server's reported version/revision. Changing servers cancels the old lookup. Older servers may report no metadata.
- `GET /api/public/build-info` reports the server component, version, source revision, build profile, OS and architecture. The response is public and marked `Cache-Control: no-store`; it contains no runtime configuration or secret values.
- `/wabi-client-build.json` identifies the embedded frontend build. An already-open client may have an older bundle; its About display identifies its own compiled bundle.

```bash
./target/release/wabi-server --build-info
curl -fsS http://localhost:3001/api/public/build-info
curl -fsS http://localhost:3001/wabi-client-build.json
```

`--build-info` exits before logging, key resolution or data initialization. Builds without a supplied source revision explicitly report `null`/unavailable.

## Stamp a source build

Set `WABI_SOURCE_REVISION` to the full Git revision of the exact clean checkout before building both parts:

```bash
export WABI_SOURCE_REVISION="$(git rev-parse HEAD)"
cd frontend
npm ci --no-audit --no-fund
STATIC_BUILD=1 npm run build
cd ..
cargo build --locked --release -p wabi-server
node scripts/write-release-manifest.mjs \
  --binary target/release/wabi-server \
  --frontend frontend/build \
  --output target/release/wabi-release-manifest.json
```

Do not label modified source as a clean upstream revision. The release workflow stamps the checked-out GitHub revision automatically. Compose forwards `WABI_SOURCE_REVISION` as a build argument; a direct image build accepts `--build-arg WABI_SOURCE_REVISION` when the variable is exported.

## Artifact manifest

The manifest records server identity and SHA-256, client identity, and the hashes/sizes of every frontend file. It refuses mismatched server/client revisions, a debug binary, a frontend without `index.html`, symbolic links, or an output that would overwrite its own inputs. Server identity is read from the actual binary; it is not inferred from a filename or a nearby Cargo manifest.

CI uploads the manifest beside the release binary. These hashes identify the artifact bytes. Publishing, signing, supported-platform certification and deployment acceptance remain separate release tasks.
