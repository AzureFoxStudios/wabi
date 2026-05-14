#!/bin/bash
# Deploy wabi-server to Iyoku (staging)
set -e

SERVER="100.104.166.42"
USER="ronin"
BINARY="wabi-server"
REMOTE_DIR="/home/ronin/wabi/bin"
PORT="3001"

echo "Deploying wabi-server to Iyoku..."

# Create remote directory
ssh ${USER}@${SERVER} "mkdir -p ${REMOTE_DIR}"

# Copy binary
echo "Copying binary..."
scp target/release/wabi-server ${USER}@${SERVER}:${REMOTE_DIR}/

# Stop old process if running
echo "Stopping old wabi-server..."
ssh ${USER}@${SERVER} "pkill -f 'wabi-server.*${PORT}' || true"

# Start new process
echo "Starting wabi-server on port ${PORT}..."
ssh ${USER}@${SERVER} "cd ${REMOTE_DIR} && nohup ./${BINARY} --port ${PORT} > wabi-server.log 2>&1 &"

# Wait for startup
sleep 3

# Health check
echo "Health check..."
ssh ${USER}@${SERVER} "curl -s http://localhost:${PORT}/health | jq ."

echo ""
echo "Deployment complete!"
echo "Server: http://${SERVER}:${PORT}"
echo "Logs: ssh ${USER}@${SERVER} 'tail -f ${REMOTE_DIR}/wabi-server.log'"
