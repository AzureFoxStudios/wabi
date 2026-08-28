# Database Reset and User Creation

## ⚠️ CRITICAL WORKFLOW CORRECTION (2026-07-28)

**User explicitly stated: "DO.NOT.MAKE.A.USER! Let me make the first account"**

When resetting the database, do NOT create users. Leave the database completely empty and let the user create the first account themselves. The registration API will work fine with an empty database - no setup is required.

**Lesson learned:** Always wait for user confirmation before creating accounts. The task description may contain explicit instructions to NOT create users.

## Resetting the Database

When you need to start fresh with a clean database:

1. **Stop the server:**
   ```bash
   ps aux | grep wabi-server | grep -v grep | awk '{print $2}' | xargs -r kill -9
   ```

2. **Remove the database directory:**
   ```bash
   rm -rf /home/Ronin/wabi/data/wabidb
   mkdir -p /home/Ronin/wabi/data/wabidb
   ```

3. **Remove lock files (if any):**
   ```bash
   rm -f /home/Ronin/wabi/data/wabidb/.lock
   ```

4. **Clean old JWT secret:**
   ```bash
   rm -f /home/Ronin/wabi/data/jwt_secret
   ```

5. **Start the server:**
   ```bash
   cd /home/Ronin/wabi
   WABIDB_ROOT_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
   WABI_CORS_ORIGINS="https://wabi.chat,http://localhost:3000,http://100.87.255.66:3000" \
   ./target/release/wabi-server --port 3000 --host 0.0.0.0 --data-dir ./data
   ```

## DO NOT Create Users (After Reset)

**After a database reset, leave the system empty.** The user will create the first account themselves via the frontend at `http://100.87.255.66:3000`.

The registration endpoint exists and will work:
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"owner_test","password":"ChangeMe123"}'
```

But **do not run this** unless explicitly asked. The user wants to create their own first account.

## Verification

Check server health:
```bash
curl -s http://localhost:3000/api/setup/status
# {"setupRequired":false}

curl -s http://localhost:3000/api/public/launch-page
# {"title":"Wabi",...}
```

The server is ready for the user to create their first account.