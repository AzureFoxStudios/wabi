#!/bin/bash
# Deploy wabi-node to Iyoku (staging server)
# Usage: ./scripts/deploy-iyoku.sh

set -e

SERVER="100.104.166.42"
USER="ronin"
PROJECT="wabi"
BINARY="wabi-node"
PORT="3001"

echo "🚀 Deploying $BINARY to Iyoku ($SERVER)..."

# Build release binary
echo "📦 Building release binary..."
cargo build --release --bin $BINARY

# Create remote directory
echo "📁 Creating remote directory..."
ssh $USER@$SERVER "mkdir -p ~/wabi/bin"

# Copy binary
echo "📤 Copying binary..."
scp target/release/$BINARY $USER@$SERVER:~/wabi/bin/

# Copy config (if exists)
if [ -f "config/iyoku.toml" ]; then
    echo "📄 Copying config..."
    scp config/iyoku.toml $USER@$SERVER:~/wabi/
fi

# Restart service on Iyoku
echo "🔄 Restarting service..."
ssh $USER@$SERVER << 'EOF'
  # Stop existing process
  pkill -f "wabi-node" || true
  
  # Start new process
  cd ~/wabi/bin
  nohup ./wabi-node --port 3001 > ~/wabi/wabi-node.log 2>&1 &
  
  echo "✅ Service started"
  sleep 2
  
  # Check if running
  if pgrep -f "wabi-node" > /dev/null; then
    echo "✅ wabi-node is running on port 3001"
  else
    echo "❌ wabi-node failed to start"
    exit 1
  fi
EOF

echo "✅ Deployment complete!"
echo ""
echo "📊 Check logs: ssh $USER@$SERVER 'tail -f ~/wabi/wabi-node.log'"
echo "🌐 Test: curl http://$SERVER:3001/health"
