#!/bin/bash
# Deploy wabi-server to the staging server ("Iyoku")
# Usage: WABI_DEPLOY_HOST=192.0.2.20 WABI_DEPLOY_USER=operator ./scripts/deploy-iyoku-wabi.sh
# Required environment (no host is hard-coded in the repository):
#   WABI_DEPLOY_HOST  staging host name or IP (e.g. 192.0.2.20)
#   WABI_DEPLOY_USER  ssh user on that host  (e.g. operator)
#   WABI_DEPLOY_DIR   optional remote directory, default wabi/bin (relative to the remote home)
set -e

SERVER="${WABI_DEPLOY_HOST:?set WABI_DEPLOY_HOST to the staging host (see the header of this script)}"
USER="${WABI_DEPLOY_USER:?set WABI_DEPLOY_USER to the ssh user on the staging host}"
BINARY="wabi-server"
REMOTE_DIR="${WABI_DEPLOY_DIR:-wabi/bin}"
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
