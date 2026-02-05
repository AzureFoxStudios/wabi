# WebSocket Connection Testing Guide

## Automated Unit Tests

Run the socket manager unit tests in your browser console:

```javascript
// Open browser DevTools (F12)
// In Console tab, run:
window.runSocketTests()
```

This will test:
- ✅ Initial connection creation
- ✅ Duplicate connection prevention
- ✅ Rapid successive calls handling
- ✅ Username switching (cleanup)
- ✅ Disconnect/reconnect flow
- ✅ Listener binding integrity

Expected output: **All 6 tests should PASS**

---

## Manual Browser Testing

### Test 1: Single Connection (No Duplicates)

1. **Open DevTools** (F12)
2. **Go to Network tab**, filter by `WS` (WebSocket)
3. **Login** to the app
4. **Observe:**
   - ✅ Only ONE WebSocket connection should be established
   - ✅ No `WebSocket is closed before connection established` errors in Console
   - ✅ One persistent WebSocket connection (green/blue icon)
   - ✅ Messages flow smoothly

**Expected:** Single connection, no errors

---

### Test 2: Page Navigation (Clean Disconnect)

1. **Login** to the app
2. **Navigate away** (go to another page/route)
3. **Navigate back**
4. **Observe:**
   - ✅ Old connection closes gracefully
   - ✅ New connection established on return
   - ✅ No lingering WebSocket connections
   - ✅ No duplicate listeners or memory leaks

**Expected:** Connection closes cleanly, new one on return

---

### Test 3: Reconnection on Network Loss

1. **Login** and establish connection
2. **Simulate network loss:**
   - DevTools → Network tab → Offline (checkbox)
3. **Wait 5-10 seconds**
4. **Turn network back on** (uncheck Offline)
5. **Observe:**
   - ✅ Connection state shows "reconnecting"
   - ✅ Exponential backoff (1s, 2s, 4s, 8s... delays)
   - ✅ Automatically reconnects without user action
   - ✅ No spam/repeated errors

**Expected:** Clean reconnection with backoff

---

### Test 4: Rapid Login/Logout

1. **Login**
2. **Immediately logout** (before connection fully establishes)
3. **Observe:**
   - ✅ No "WebSocket is closed" errors
   - ✅ Connection terminates cleanly
   - ✅ No dangling listeners

**Expected:** No errors, clean termination

---

### Test 5: Message Delivery (No Duplicates)

1. **Login** with User A
2. **Open second browser tab/window**
3. **Login** with User B in second tab
4. **User A sends a message**
5. **Observe in User B's view:**
   - ✅ Message appears ONCE
   - ✅ No duplicate message entries
   - ✅ No repeated notifications

**Expected:** Message appears exactly once

---

### Test 6: Typing Indicators

1. **Login** with User A
2. **Login** with User B in second tab
3. **User A starts typing** a message
4. **Observe in User B's view:**
   - ✅ "User A is typing..." appears
   - ✅ Indicator disappears when A stops typing
   - ✅ Only ONE typing indicator (no duplicates)

**Expected:** Single, responsive typing indicator

---

### Test 7: Cross-Browser Testing

Repeat tests 1-6 in:
- ✅ Chrome/Chromium
- ✅ Firefox
- ✅ Edge
- ✅ Safari (if available)

**Expected:** All tests pass consistently in all browsers

---

## Console Monitoring

Open DevTools Console and watch for:

### ✅ Good Signs
```
[SocketManager] Connecting to: https://wabi.chat (registered)
[SocketManager] Connected! <socket-id>
[SocketManager] Received init
[SocketManager] Already connected with same username, reusing connection
```

### ❌ Bad Signs (Should NOT see these)
```
[SocketManager] Closing existing connection before reconnecting
[SocketManager] Connection already in progress, skipping
WebSocket is closed before the connection is established
WebSocket connection established (duplicate messages)
```

---

## Debugging Tips

### Enable Socket Logging

Add to `socket.ts` if needed for debugging:
```typescript
console.log('[SocketManager] Event:', eventName, data);
```

### Check Socket State

In browser console:
```javascript
// Check socket connection state
const socket = document.querySelector('[data-socket]')?.__sveltekit?.socketManager
socket?.getSocket()  // Should show one socket object

// Check if connecting
socket?.getIsConnecting()  // Should be false when idle

// Check username
socket?.getUsername()  // Should show current user
```

### Monitor Network Tab

Look for:
- **WebSocket (101 Switching Protocols)** - indicates successful connection
- **Connection time** - should be < 1 second for local/fast networks
- **Messages** - should see periodic pings and data flow

---

## Test Checklist

- [ ] Unit tests pass: `window.runSocketTests()`
- [ ] Single connection on login
- [ ] No "WebSocket is closed" errors
- [ ] Clean disconnect on logout
- [ ] Reconnection with backoff on network loss
- [ ] No duplicate messages
- [ ] No duplicate typing indicators
- [ ] Cross-browser works (Chrome, Firefox, Edge)
- [ ] No memory leaks (DevTools → Memory tab)
- [ ] Connection persists across page navigations

---

## Known Issues

### Database Error (Pre-existing)
```
SqliteError: duplicate column name: business_private_mode
```
This is a backend schema migration issue, not WebSocket-related.

### Theme/Business Sync Errors (Pre-existing)
```
POST /api/business/sync 403 (Forbidden)
POST /api/user/theme 400 (Bad Request)
```
These are API issues, not WebSocket-related.

---

## Performance Metrics

After testing, check DevTools → Performance:

- **Connection time:** < 500ms
- **Message latency:** < 100ms
- **Memory growth:** Stable (no leaks)
- **CPU usage:** Minimal (no busy loops)

---

## Still Having Issues?

If tests fail, check:
1. Server is running: `docker logs wabi-backend`
2. Frontend built with latest code: `npm run build`
3. Browser cache cleared: Ctrl+Shift+Delete (or Cmd+Shift+Delete on Mac)
4. Check CORS headers in Network tab
5. Verify Socket.IO server is accepting connections

