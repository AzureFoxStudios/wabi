# Tim Deploy: glibc-compatible wabi-server builds

## Problem observed

A `wabi-server` binary built directly on Ronin/Bazzite/Fedora deployed successfully to Tim's bind-mounted host path, but the Debian runtime container immediately restart-looped with:

```text
/wabi-server: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /wabi-server)
```

The container did not need a host `sudo update`. The binary had been linked against Ronin's newer glibc, while Tim's runtime container provides an older Debian glibc.

## Correct fix

Build the release binary in a Debian-compatible Rust container after the frontend static build:

```bash
cd /var/home/Ronin/wabi
cd frontend
STATIC_BUILD=1 bun run build
cd ..

podman run --rm \
  -v /var/home/Ronin/wabi:/work:Z \
  -w /work \
  docker.io/library/rust:1-bookworm \
  bash -lc 'export PATH=/usr/local/cargo/bin:$PATH; apt-get update >/tmp/apt.log && apt-get install -y pkg-config libssl-dev >/tmp/apt-install.log && cargo build --release -p wabi-server'
```

Why `export PATH=/usr/local/cargo/bin:$PATH`: in one rootless Podman run, the Rust image contained cargo under `/usr/local/cargo/bin` but it was not on PATH after the mounted workdir/container invocation.

## Verify before shipping

```bash
file target/release/wabi-server
strings target/release/wabi-server | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -10
```

Expected for Tim's current Debian runtime: highest glibc requirement around `GLIBC_2.34`, not `GLIBC_2.39`.

## Deploy sequence

```bash
scp target/release/wabi-server tim@100.96.11.45:~/Desktop/Wabi/target/release/wabi-server.new
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose -p wabi stop wabi-server >/dev/null && mv target/release/wabi-server.new target/release/wabi-server && chmod +x target/release/wabi-server && docker compose -p wabi up -d wabi-server'
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose -p wabi ps wabi-server && curl -fsS http://127.0.0.1:3001/health'
```

## Verification that the fix worked

After the compatible binary was deployed:

```text
wabi-server   Up ... (healthy)
/health -> {"role":"authority","service":"wabi-server","status":"ok","version":"0.1.0"}
docker inspect -> restart=0 status=running health=healthy
```
