#!/bin/bash
# Wabi Native Server Launcher
# Starts SpacetimeDB + wabi-server in one command

set -e

echo "🚀 Starting Wabi..."

# Configuration
STDB_DATABASE="${WABI_STDB_DATABASE:-wabi-state-benchmark-v2}"
MODULE_PATH="${WABI_MODULE_PATH:-spacetimedb/wabi_state_bridge}"
WABI_BINARY="${WABI_BINARY:-./target/release/wabi-server}"

# Check if SpacetimeDB is installed
if ! command -v spacetimedb &> /dev/null; then
    echo "❌ SpacetimeDB not found"
    echo ""
    echo "Install with:"
    echo "  curl -sSf https://install.spacetimedb.com | sh"
    echo ""
    exit 1
fi

# Check if wabi-server binary exists
if [ ! -f "$WABI_BINARY" ]; then
    echo "❌ wabi-server binary not found: $WABI_BINARY"
    echo ""
    echo "Build with:"
    echo "  cargo build --release --bin wabi-server"
    echo ""
    exit 1
fi

# Check if SpacetimeDB is running
if ! pgrep -f "spacetimedb start" > /dev/null; then
    echo "📦 Starting SpacetimeDB..."
    spacetimedb start &
    STDB_PID=$!
    
    # Wait for STDB to be ready
    echo "   Waiting for SpacetimeDB to start..."
    for i in {1..30}; do
        if curl -s http://localhost:3000/v1/ping > /dev/null 2>&1; then
            echo "   ✅ SpacetimeDB ready"
            break
        fi
        sleep 1
    done
    
    # Check if we succeeded
    if ! curl -s http://localhost:3000/v1/ping > /dev/null 2>&1; then
        echo "❌ SpacetimeDB failed to start"
        exit 1
    fi
else
    echo "✅ SpacetimeDB already running"
fi

# Publish module
echo "📤 Publishing module to SpacetimeDB..."
spacetimedb publish --module-path "$MODULE_PATH" "$STDB_DATABASE" --yes

if [ $? -ne 0 ]; then
    echo "❌ Failed to publish module"
    exit 1
fi

echo "✅ Module published"
echo ""
echo "🚀 Starting wabi-server..."
echo ""

# Start wabi-server (replace this shell process)
exec "$WABI_BINARY" "$@"
