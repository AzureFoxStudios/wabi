# Deploy wabi-node to Iyoku - Manual Steps

## 1. SSH to Iyoku
```bash
tailscale ssh ronin@iyoku
# Or use your SSH key if configured
```

## 2. Copy the binary
```bash
# From your local machine:
scp ~/Desktop/Wabi/dotronin-worktree/wabi/target/release/wabi-node ronin@100.104.166.42:~/wabi/bin/
```

## 3. Start wabi-node on Iyoku
```bash
# SSH into Iyoku
cd ~/wabi/bin
pkill -f "wabi-node" || true
nohup ./wabi-node --port 3001 > wabi-node.log 2>&1 &
```

## 4. Verify it's running
```bash
# Check process
ps aux | grep wabi-node

# Check health
curl http://localhost:3001/health | jq .

# Check logs
tail -f wabi-node.log
```

## 5. Test from your machine
```bash
# Should return real data from SpacetimeDB
curl http://100.104.166.42:3001/api/channels | jq .
curl http://100.104.166.42:3001/health | jq .
```

## 6. Test wabi.chat
1. Open wabi.chat in browser
2. Check network tab - change API endpoint to `http://100.104.166.42:3001`
3. Try to login/register
4. Send a message

## 7. Verify mesh (if Tim is still running old backend)
- Check if Iyoku can see Tim's presence
- Send message from Iyoku, verify Tim receives it
- Check logs on both servers
