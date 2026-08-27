# Tailscale SSH Auth — One-Time Node vs Repeated Login Pain

## One-Time Node Auth

Tailscale node login is **one-time per device**. Once `tailscale up` runs on a machine and the user approves the OAuth link, that device stays on the tailnet indefinitely (until key expiry forces re-auth or the admin deletes the node).

- This is **not** per-SSH-session.
- This is **not** per-agent-session (Hermes, Codex, OpenCode all use the same underlying node).
- If Ronin is already approved on the tailnet, the node itself is authorized.

## What Agents Do

All agents follow the same pattern for Tailscale SSH access:
1. Run `tailscale up --ssh` (or try `ssh user@host` over a Tailscale IP).
2. Tailscale daemon emits an auth URL like `https://login.tailscale.com/a/<hash>`.
3. Agent captures the URL from stdout/stderr and hands it to the user.
4. User opens the link in their browser and hits **Authorize**.
5. Node joins the tailnet; subsequent SSH commands through Tailscale should work.

This happens **once per device**, not every time the agent runs.

## Smartphone / Mobile SSH Clients (No Session Persistence)

When the user says "bluntly it is" and reveals they are SSH'ing from a phone terminal app, the root cause is **session zeroing**, not Tailscale node auth or key expiry.

- Phone SSH apps open a new local shell on each connect. No `tmux`, no `screen`, no `ssh-agent` forwarding.
- Any cached SSH keys, agent identities, or even Tailscale daemon state that lives in a desktop session do not exist.
- The user may need to re-auth Tailscale SSH host approval every session if the phone Tailscale app itself is not running as the same node.

**Mitigation (notfix):** Ask if they can keep a `tmux` session alive on an intermediate machine (like Ronin) and just re-attach. Otherwise the auth is an unavoidable cost of the client.

---

## The Real Causes of Repeated Login Pain (Desktop Context)

If the user says "I have to log in to Google over and over," the node auth is already done. The pain comes from one of these three issues:

### 1. Key Expiry Enabled on the Tailnet

Tailnet admins can enforce periodic re-authentication. When key expiry triggers, the node drops off the tailnet and any connection attempt produces a fresh OAuth URL.

- Check: `tailscale status` shows "Needs login" or similar.
- Fix: In the Tailscale admin console, find the node and disable key expiry, or set it very long (e.g., 180 days). The option is usually under the machine ">" menu → Disable key expiry.

### 2. SSH Key Passphrases (Not Tailscale SSH)

If the command used is bare `ssh user@100.x.x.x` with OpenSSH, and the SSH key on disk (e.g., `~/.ssh/id_ed25519`) has a passphrase, OpenSSH prompts for the passphrase every session unless `ssh-agent` is running and the key is loaded.

- Check: `ssh-add -l` — if it lists identities, the agent is already holding them. If it says "Could not open a connection to your authentication agent," the agent is not running.
- Fix: Run `eval "$(ssh-agent -s)" && ssh-add`, or start the agent on login via shell profile/systemd user service. Alternatively, use the Tailscale CLI SSH feature (see #3).

### 3. Tailscale SSH Feature Disabled on the Target Machine

Tailscale SSH lets you connect with `tailscale ssh user@host` without any SSH keys or passphrases at all. It uses Tailscale ACLs for authorization. If this feature is **not** enabled on the target (tim, Iyoku, ironin), connections fall back to regular OpenSSH, which brings back key/passphrase prompts.

- Check: On the target machine, run `tailscale status` and look for the SSH badge (`●` or `>`). Or look in the admin console for whether Tailscale SSH is approved for that machine.
- Fix: In the Tailscale admin console, approve Tailscale SSH for the target machine under its ACL settings. Once enabled, `tailscale ssh tim@tim` (or `tailscale ssh user@100.x.x.x`) should work with zero prompt.

## Diagnostic Quick-Check

When the user mentions repeated auth pain, run these before assuming Tailscale itself is the problem:

```bash
# Is Ronin's node still on the tailnet?
tailscale status

# Is key expiry the issue?
tailscale status --json | grep -i "keyExpiry"

# Are we using Tailscale SSH or bare OpenSSH?
# Look at the command that triggered the pain.
# If it was `ssh user@100.x.x.x`, it's bare OpenSSH.
# If it was `tailscale ssh user@host`, it's Tailscale SSH.
```

## Extracting the Auth URL on a Command Hit (Wabi agent pattern)

When a `ssh`/`scp`/`rsync` to a Tailscale host bounces with "Tailscale SSH requires an additional check", the agent MUST extract and hand over the `login.tailscale.com/a/<hash>` URL immediately — do NOT just report "blocked" or "denied" and stop. Ronin cannot approve what he cannot see. This is a first-class correction (2026-07-18): I reported "blocked" instead of surfacing the link; the user had to ask "supposed to send me the web auth."

### Deterministic probe to get the URL

Run a non-interactive SSH attempt with publickey-only; the daemon prints the URL to stderr even though auth fails:

```bash
KEY=~/.ssh/id_ed25519
for u in tim root; do
  echo "===== $u@100.96.11.45 ====="
  timeout 8 ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o ConnectTimeout=5 -o PreferredAuthentications=publickey \
    ${u}@100.96.11.45 'echo OK' 2>&1 \
    | grep -iE "login.tailscale|additional|authenticate" | head -3
done
```

Each OS user (`tim`, `root`, ...) emits its own distinct URL. Hand BOTH to the user if unsure which account they want to scp as, and let them click the matching one.

### Flow after extraction

1. Print the raw `https://login.tailscale.com/a/<hash>` link(s) verbatim.
2. Wait for the user to open + Authorize in browser.
3. Re-issue the original command (scp/ssh/rsync). It should now pass the Tailscale checkpoint.
4. Note: even after web-auth clears, `scp` to a raw `100.x` IP triggers a SEPARATE client-side command-approval prompt (security scan on raw-IP URLs). The user must click **allow** on that prompt too. A "BLOCKED" result at that stage is the consent guard, not Tailscale — re-issue the same command once the user says they are watching / send it.

## Linked Remote Machines (Wabi context)

| Host | Tailscale IP | Tailscale SSH enabled? |
|------|-------------|------------------------|
| tim | 100.96.11.45 | Check in admin console |
| Iyoku | 100.104.166.42 | Check in admin console |
| ironin | 100.80.172.12 | Check in admin console |

Fix the root cause (key expiry, agent, or Tailscale SSH toggle) rather than re-authing every session.
