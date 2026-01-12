# Phase 2: Testing & Verification Guide

## Overview
This guide covers comprehensive testing of Phase 2 (Registered Users + Offline Messaging) implementation.

**Status:** All code complete, ready for manual testing.

---

## Pre-Testing Checklist

- [ ] Backend: `npm run build` ✅
- [ ] Frontend: `npm run build` ✅
- [ ] Backend server runs: `npm start`
- [ ] Frontend dev server runs: `npm run dev`
- [ ] Both can connect without errors
- [ ] Browser console shows no TypeScript errors

---

## Test 1: Temp User Flow (Regression Check)

**Objective:** Ensure existing temporary user functionality still works.

### Steps:
1. Start both servers (backend on :3000, frontend on :5173)
2. Navigate to http://localhost:5173
3. Login page shows three tabs: **Guest | Login | Register**
4. Click **Guest** tab
5. Enter a username (e.g., "Alice")
6. Click "Join as Guest"

### Expected Results:
- ✅ User joins as temporary user
- ✅ Can see channels and users list
- ✅ Can send and receive messages in real-time
- ✅ Username stored in localStorage (not authToken)
- ✅ No "offline messages" on login
- ✅ No settings panel visible for temp users

### Browser Console Checks:
```
[Socket] Connected to: http://localhost:3000 (with existing session)
[Socket] Looking for current user. Socket ID: [id]
[Socket] ✅ Found current user: { id, username, color, ... }
```

---

## Test 2: Registration

**Objective:** Create a new registered user account.

### Steps:
1. Reload page or click Register tab
2. Click **Register** tab
3. Enter:
   - Username: "bob" (must be 2-32 chars, unique)
   - Password: "password123" (must be 8+ chars)
   - Confirm: "password123"
4. Click "Create Account"

### Expected Results:
- ✅ User registers successfully
- ✅ Redirected to main chat view
- ✅ JWT token saved to localStorage as `authToken`
- ✅ Username appears in user list
- ✅ Can see badge indicating registered user

### Database Checks:
```sql
-- In backend terminal or SQLite browser
sqlite3 /app/data/chat.db

SELECT * FROM users WHERE username = 'bob';
-- Should show: id, username, password_hash (bcrypt), color, created_at

SELECT * FROM sessions WHERE user_id = 1;
-- Should show: session linked to user_id

SELECT * FROM user_settings WHERE user_id = 1;
-- Should show: offline_message_retention='7d', allow_temp_user_messages=1
```

### Validation Errors to Check:
- Empty username: "Username must be at least 2 characters"
- Duplicate username: "User already exists"
- Short password: "Password must be at least 8 characters"
- Passwords don't match: "Passwords do not match"

---

## Test 3: Login

**Objective:** Login with registered user credentials.

### Setup:
- Have one registered user account (from Test 2)

### Steps:
1. Logout or open incognito window
2. Click **Login** tab
3. Enter:
   - Username: "bob"
   - Password: "password123"
4. Click "Login"

### Expected Results:
- ✅ Login succeeds
- ✅ Redirected to chat
- ✅ Same user data shown (username, color, profile picture preserved)
- ✅ JWT token saved to localStorage
- ✅ Previous DM channels still exist (if any)

### Failed Login Scenarios:
- Wrong password: "Login failed"
- Non-existent username: "Login failed"
- Empty fields: "Username and password required"

---

## Test 4: Offline Messaging

**Objective:** Test message queueing for offline registered users.

### Prerequisite:
- Have 2 registered users: "alice" and "bob"

### Scenario A: Registered → Registered Offline DM

#### Steps:
1. **Window 1 (Alice):**
   - Login as "alice"
   - Open DM with "bob"
   - Start typing to open the DM channel

2. **Window 2 (Bob):**
   - Login as "bob"
   - Note the open DM channel with "alice"

3. **Window 1 (Alice):**
   - Send message: "Hello Bob!"
   - Message appears immediately (Bob is online)

4. **Window 2 (Bob):**
   - See message from Alice in real-time
   - Send message: "Hi Alice!"

5. **Window 1 (Alice):**
   - See Bob's message

6. **Window 2 (Bob):**
   - Close browser tab/window (simulate offline)
   - Wait 2 seconds

7. **Window 1 (Alice):**
   - Send message: "Are you there?" (Bob is now offline)
   - Verify "Message queued for offline delivery" indicator

8. **Window 2 (Bob):**
   - Reopen browser/reconnect
   - Verify message "Are you there?" appears
   - Should see notification: "📬 Offline Messages - You have 1 new message"

### Expected Results:
- ✅ Online messages delivered in real-time
- ✅ Offline messages queued on server
- ✅ Offline messages delivered on reconnect
- ✅ No duplicate messages

### Database Verification:
```sql
-- Check offline_messages table
SELECT * FROM offline_messages
  WHERE to_user_id = (SELECT user_id FROM users WHERE username = 'bob')
  AND delivered = 0;

-- After Bob reconnects, delivered should be 1:
SELECT * FROM offline_messages
  WHERE to_user_id = (SELECT user_id FROM users WHERE username = 'bob')
  AND delivered = 1;
```

### Scenario B: Temp → Registered Offline DM

#### Setup:
- One registered user "alice"
- One temporary user "guest123"

#### Steps:
1. **Window 1 (Alice - Registered):**
   - Login as "alice"

2. **Window 2 (Guest):**
   - Login as guest (temp user) "guest123"
   - Open DM with "alice"

3. **Window 1 (Alice):**
   - Accept DM from guest (if needed)

4. **Window 2 (Guest):**
   - Send message: "Hi from temp user!"
   - Close tab (go offline)

5. **Window 1 (Alice):**
   - Send message: "Hello temp user!" (guest is offline)
   - Verify message is queued

6. **Window 2 (Guest):**
   - Refresh/reconnect

### Expected Results:
- ⚠️ Temp user DOES NOT receive offline messages (temp users have no persistence)
- ✅ Registered user CAN send offline messages TO temp users (but they're lost)
- ✅ This is expected behavior (temp = ephemeral)

---

## Test 5: User Settings

**Objective:** Test offline message retention configuration.

### Steps:
1. Login as registered user "alice"
2. Open User Settings (check your UI for settings menu/button)
3. Current settings should show:
   - Retention: "7 Days (recommended)"
   - Allow temp users: ✓ (checked)

4. Change retention to "30 Days"
5. Uncheck "Allow temp users to send me offline messages"
6. Click "Save Settings"

### Expected Results:
- ✅ Settings save successfully
- ✅ Message appears: "✓ Settings saved successfully"
- ✅ Refresh page → settings persist

### Verification:
1. Reload page
2. Settings should still be "30 Days" and unchecked
3. Temp user tries to send offline message to alice
4. Verify temp user messages are NOT queued (based on allow_temp_user_messages=0)

### Retention Period Testing:
For this test, you'd need to:
1. Set retention to "1d"
2. Send offline message to user
3. Manually advance time or wait
4. Run database cleanup job: Check that messages expire

For now, just verify the setting is saved in the database.

---

## Test 6: Upgrade (Temp → Registered)

**Objective:** Convert temporary user to registered account.

### Prerequisites:
- Have a temporary user already in the system

### Steps:
1. **Login as temp user:**
   - Click Guest tab
   - Username: "tempuser"
   - Click "Join as Guest"

2. **Look for Upgrade button:**
   - UI should have "Upgrade to Registered" button (location TBD based on your UI)
   - Or check Settings panel

3. **Click Upgrade to Registered:**
   - Enter password: "newpass123"
   - Confirm: "newpass123"
   - Click "Upgrade"

### Expected Results:
- ✅ Upgrade succeeds
- ✅ Username "tempuser" is now registered
- ✅ Same color and profile picture preserved
- ✅ Can now receive offline messages
- ✅ JWT token saved to localStorage

### Database Verification:
```sql
SELECT * FROM users WHERE username = 'tempuser';
-- Should show: password_hash, created_at, etc.

SELECT * FROM user_settings WHERE user_id = (SELECT user_id FROM users WHERE username = 'tempuser');
-- Should show default settings
```

---

## Test 7: Security Verification

### 7.1 Password Hashing

**Objective:** Ensure passwords are hashed, not stored plaintext.

#### Steps:
1. Register user "sectest" with password "securepass123"
2. Open database:
```bash
sqlite3 /app/data/chat.db
SELECT password_hash FROM users WHERE username = 'sectest';
```

#### Expected Results:
- ✅ Password hash starts with `$2b$` (bcrypt format)
- ✅ Hash is 60 characters long
- ✅ Does NOT show plaintext "securepass123"

**Example bcrypt hash:**
```
$2b$10$N7JQXfLoXgXrKJXIWh4CPeHx8R5YLHpFk8bvj3YqJ3Z1KzGFvRWAm
```

### 7.2 JWT Token Expiration

**Objective:** Verify JWT tokens expire after 30 days.

#### Steps:
1. Login as registered user
2. Check token in localStorage:
```javascript
// In browser console
const token = localStorage.getItem('authToken');
const decoded = JSON.parse(atob(token.split('.')[1]));
console.log(decoded);
```

#### Expected Results:
- ✅ Token has `exp` field
- ✅ `exp` is 30 days from creation
- ✅ Format: Unix timestamp (seconds since epoch)

**Example decoded token:**
```json
{
  "sessionId": "reg-...",
  "userId": 1,
  "isTemporary": false,
  "iat": 1705276800,
  "exp": 1707955200
}
```

### 7.3 SQL Injection Protection

**Objective:** Verify parameterized queries prevent SQL injection.

#### Steps:
1. Registration form
2. Username field, try entering: `'; DROP TABLE users; --`
3. Try password: `" OR 1=1 --`

#### Expected Results:
- ✅ Attempt rejected (likely as duplicate or invalid username)
- ✅ No SQL error message leaked
- ✅ Database still intact (can still login with valid user)

### 7.4 Rate Limiting

**Objective:** Verify rate limiting on auth endpoints.

#### Registration Rate Limit: 5 per 15 minutes

#### Steps:
1. Try registering 6 users rapidly:
```bash
for i in {1..6}; do
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"user$i\",\"password\":\"pass123456\"}"
  echo ""
done
```

#### Expected Results:
- ✅ First 5 succeed
- ✅ 6th fails with: `Too many registration attempts`
- ✅ Wait 15+ minutes, then can register again

#### Login Rate Limit: 10 per 5 minutes

Similar test with login endpoint.

### 7.5 Authentication Header Validation

**Objective:** Verify protected endpoints require valid auth.

#### Steps:
1. Try accessing user settings without token:
```bash
curl http://localhost:3000/api/user/settings
```

#### Expected Results:
- ✅ Returns 401 Unauthorized
- ✅ Message: "Missing or invalid authorization"

2. Try with fake token:
```bash
curl -H "Authorization: Bearer fake.token.here" \
  http://localhost:3000/api/user/settings
```

#### Expected Results:
- ✅ Returns 401
- ✅ User not authenticated

---

## Test 8: Integration Tests

### Scenario: Full User Lifecycle

#### Part 1: Temp User Joins
1. Open incognito window
2. Login as temp user "charlie"
3. Send message in #general
4. ✅ Message appears immediately

#### Part 2: Upgrade to Registered
5. Find "Upgrade to Registered" button
6. Set password "charlie123"
7. ✅ Successfully upgraded
8. ✅ "charlie" now appears as registered user (badge visible)
9. ✅ Same color and profile picture maintained

#### Part 3: Offline Messaging
10. Open second window, login as "alice" (registered)
11. Go to #general, see "charlie" (now registered)
12. Create DM with "charlie"
13. Send offline message: "Testing offline message"
14. Go back to window 1 (charlie), close tab
15. From window 2, send DM: "Charlie, you there?"
16. Go back to window 1, reconnect
17. ✅ "Testing offline message" arrives
18. ✅ Notification shows: "📬 Offline Messages - You have 1 new message"

#### Part 4: Settings
19. Open settings panel
20. ✅ Can see retention options
21. ✅ Can toggle temp user messages
22. ✅ Settings save to database

#### Part 5: Re-Login
23. Logout
24. Login as "charlie" with password "charlie123"
25. ✅ All previous DM channels restored
26. ✅ Can receive new offline messages

---

## Test 9: Edge Cases

### 9.1 Concurrent Logins

**Test:** Same user logs in from 2 windows

#### Steps:
1. Window 1: Login as "dave" (registered)
2. Window 2: Login as "dave" (same user)
3. Both should work

#### Expected Results:
- ✅ Both windows show same user data
- ✅ No conflict/error
- ✅ Messages sync across both windows

### 9.2 Rapid Offline/Online Cycling

**Test:** User goes offline/online repeatedly

#### Steps:
1. Alice and Bob both registered
2. Bob offline, Alice sends messages
3. Bob reconnects, gets offline messages
4. Bob goes offline again, Alice sends more messages
5. Bob reconnects again

#### Expected Results:
- ✅ All offline messages delivered in order
- ✅ No duplicates
- ✅ Timestamps preserved

### 9.3 Very Long Offline Duration

**Test:** User offline for extended period

#### Steps:
1. Set retention to "1d"
2. User goes offline
3. Other users send 50+ messages over 25 hours
4. User comes back online

#### Expected Results:
- ✅ Only messages from last 24 hours delivered
- ✅ Older messages already deleted (retention job)
- ✅ No performance issues with large message queue

---

## Manual Testing Checklist

### Before Each Test Session
- [ ] Clear localStorage (or use incognito)
- [ ] Close all tabs
- [ ] Restart both servers
- [ ] Check database is fresh (or note state)

### Regression Tests
- [ ] Temp users can still join and chat
- [ ] Real-time messaging works
- [ ] Channels persist across sessions

### New Features
- [ ] Registration works
- [ ] Login works
- [ ] Offline messaging queued and delivered
- [ ] Settings saved and respected
- [ ] Upgrade path works

### Security
- [ ] Passwords are hashed
- [ ] JWT tokens expire
- [ ] Rate limiting works
- [ ] SQL injection blocked
- [ ] Auth headers validated

---

## Known Limitations & Future Work

### Current Limitations:
1. **No Email Verification:** Users can register with any email-like username
2. **No Password Reset:** If user forgets password, no recovery
3. **No 2FA:** No two-factor authentication
4. **Limited Settings:** Only retention and temp user message toggle
5. **No User Search:** Can only DM if you know their username

### Future Enhancements (Phase 3+):
1. E2E Encryption (Phase 3)
2. Password reset via email
3. User profiles with bio, avatar
4. Block user feature
5. Group DMs (not just 1-to-1)
6. Read receipts
7. Typing indicators
8. User search and discovery

---

## Troubleshooting

### Issue: "Cannot register" / "Server error"
1. Check backend logs
2. Ensure database file exists: `/app/data/chat.db`
3. Verify backend is running on :3000

### Issue: "JWT verification failed"
1. Check `JWT_SECRET` env variable is set
2. Verify token hasn't expired
3. Ensure token is correctly formatted in localStorage

### Issue: "Offline messages not arriving"
1. Verify recipient is registered user
2. Check database: `offline_messages` table has entries
3. Verify `delivered=0` before reconnect, `delivered=1` after
4. Check socket reconnects properly

### Issue: "Settings not saving"
1. Verify JWT token is in Authorization header
2. Check `user_settings` table has entry for user
3. Ensure user is registered (temp users can't have settings)

---

## Success Criteria

✅ Phase 2 is considered **COMPLETE** when ALL of the following pass:

- [ ] Temp user regression tests pass
- [ ] Registration works end-to-end
- [ ] Login works end-to-end
- [ ] Offline messages queue and deliver
- [ ] Settings persist
- [ ] User upgrade works
- [ ] No SQL injection vulnerabilities
- [ ] Passwords are hashed (bcrypt)
- [ ] JWT tokens have expiration
- [ ] Rate limiting blocks abuse
- [ ] Both servers build without errors
- [ ] No console errors in browser

---

## Next Steps After Testing

1. **If all tests pass:**
   - Commit code: "Phase 2: Registered users + offline messaging"
   - Plan Phase 3: E2E Encryption

2. **If issues found:**
   - Document bug in GitHub Issues
   - Fix and re-test specific test case
   - Update documentation as needed

---

**Last Updated:** January 12, 2026
**Phase Status:** ✅ Code Complete - Ready for Testing
