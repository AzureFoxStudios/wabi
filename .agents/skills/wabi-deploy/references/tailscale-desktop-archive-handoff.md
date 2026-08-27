# Tailscale Desktop Archive Handoff

Use this when the user asks to send the Wabi project archive/zip to Ironin or Tim's Desktop instead of doing a live deploy or destructive repo sync.

## Rules

- Treat this as a file handoff only. Do not stop/restart services, rsync into the repo, or touch Tim unless explicitly requested.
- Prefer a resumable transfer for large archives over plain `scp`.
- If an approval prompt is denied because the user missed it, ask plainly and retry only after the user explicitly says to ask again / approve.
- If a transfer times out or the host goes offline, do not blindly start over. First verify whether the remote file exists and whether its SHA matches.

## Recommended flow

1. Create archive locally under `/var/home/Ronin/Desktop/Wabi/backups/`, excluding generated/runtime folders:
   - `.git/`
   - `node_modules/`, `frontend/node_modules/`
   - `target/`, `core/target/`, `spacetimedb/target/`
   - `frontend/.svelte-kit/`, `frontend/build/`
   - `data/`, `uploads/`, `logs/`, `*.log`, `.env`, `.env.*`

2. Record local size and SHA:
   ```bash
   ls -lh /var/home/Ronin/Desktop/Wabi/backups/<archive>.zip
   sha256sum /var/home/Ronin/Desktop/Wabi/backups/<archive>.zip
   ```

3. For large archives over Tailscale, prefer resumable rsync:
   ```bash
   rsync -avP --partial --inplace \
     /var/home/Ronin/Desktop/Wabi/backups/<archive>.zip \
     ironin@100.80.172.12:/home/ironin/Desktop/
   ```
   Use `scp` only for smaller files or when the user specifically wants it.

4. Verify remote before reporting success:
   ```bash
   ssh ironin@100.80.172.12 \
     'ls -lh /home/ironin/Desktop/<archive>.zip; sha256sum /home/ironin/Desktop/<archive>.zip'
   ```

5. If Tailscale SSH says approval is required, paste the raw approval URL and stop until the user confirms. If command approval is denied in the CLI UI, explicitly restate the command and ask again; do not treat a distracted denial as a final refusal unless the user says no.

## Failure handling

- Timeout during copy: check remote file size/SHA first.
- Host offline after timeout: report that verification is impossible until it returns, and keep the local archive path/SHA in the final response.
- Partial remote file: resume with `rsync -avP --partial --inplace`, not another full `scp`.
