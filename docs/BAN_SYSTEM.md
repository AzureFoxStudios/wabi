# Wabi Ban System

## Overview

Wabi implements a simple, file-based blacklist system for banning users and IPs. This fits the self-hosted philosophy: transparent, editable by the user, and bypassable by power users who run their own instance.

## File Location

By default: `./data/blacklist.txt` (relative to wabi-server binary)
Can be overridden with env var: `WABI_BLACKLIST_FILE=/path/to/blacklist.txt`

## File Format

```
# Comments start with #
type|value|reason|expires_timestamp
```

**Fields:**
- `type`: Either `user` or `ip`
- `value`: User ID (i64) or IP address string
- `reason`: Human-readable reason for the ban
- `expires_timestamp`: Unix timestamp (seconds since epoch). Use `0` for permanent bans.

## Examples

```txt
# Permanent ban on user ID 123 for spam
user|123|spam|0

# Temporary ban on user ID 456 until Jan 1, 2025
user|456|abuse|1735689600

# Permanent IP ban
ip|192.168.1.100|repeat spam|0
```

## How It Works

1. **On Startup**: wabi-server loads `blacklist.txt` into memory
2. **On Login/Register**: Server checks if the user ID is in the blacklist
3. **If Banned**: Login fails with "Account banned: {reason}"
4. **Manual Edit**: Admin edits the file and restarts the server to apply changes

## Ban Evasion

This system is designed to stop **casual abuse**, not determined attackers:

**What it stops:**
- Average users (won't bother creating new accounts)
- Automated spam bots (static IPs, bulk accounts)
- Casual ban evaders (too much friction)

**What it doesn't stop:**
- Motivated individuals (will use VPN, new accounts)
- Targeted attackers (dedicated effort)

**Power User Bypass:**
If you're banned and run your own Wabi instance, you can:
1. Edit your local `blacklist.txt` to remove your entry
2. Or just don't include a blacklist file

This is **intentional**. Self-hosting means you control your instance.

## Admin Workflow

### Ban a User

1. Get the user's ID (from database or logs)
2. Edit `blacklist.txt`:
   ```
   user|123|spam|0
   ```
3. Restart wabi-server:
   ```bash
   docker restart wabi-server
   # or
   systemctl restart wabi-server
   ```

### Unban a User

1. Edit `blacklist.txt` and remove the line
2. Restart wabi-server

### Check Ban Status

1. Look in `blacklist.txt` for the user ID
2. Check server logs for `[blacklist]` messages

## Rate Limiting (Future)

Currently not implemented. Future enhancement:
- Track failed login attempts per IP
- Auto-ban after N failures within M minutes
- Temporary cooldowns (5 min, 1 hour)

## Integration Points

**Current:**
- Login endpoint (`/api/auth/login`)
- Registration endpoint (`/api/auth/register`)
- Guest login endpoint (`/api/auth/guest`)

**Future:**
- Socket.IO connection (disconnect banned users)
- Message sending (reject from banned users)
- Admin API endpoints (ban/unban without restart)

## Technical Details

**Module:** `src/blacklist.rs`
- `BlacklistManager`: Loads and checks blacklist
- `BlacklistEntry`: Individual ban entry
- `BlacklistType`: `User` or `Ip`

**State:** `src/state.rs`
- `AppState.blacklist`: `RwLock<Option<Arc<BlacklistManager>>>`

**Loading:** `src/main.rs`
- Loads blacklist after creating `AppState`
- Creates empty file if missing

## Security Notes

- Blacklist is **in-memory** after load (fast checks)
- File edits require **server restart** (intentional for simplicity)
- No encryption (admin has file system access anyway)
- Logs ban checks at `info` level for audit trail
