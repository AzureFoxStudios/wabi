#!/bin/bash
# Wabi TUI - Quick Start Guide

## Build
cd /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi
cargo build -p wabi-tui --release

## Install (adds to PATH via cargo)
cargo install --path core/crates/wabi-tui

## Run
wabi-tui
# or directly:
./target/release/wabi-tui

## First Run
On first launch you will be prompted to enter your Wabi server URL.
The URL is saved to ~/.config/wabi/config.toml for subsequent runs.

## Config file location
# ~/.config/wabi/config.toml
# File is created with mode 0600 (owner-only read/write).

## Key Bindings
# q          - Quit
# i          - Enter input mode (type message)
# j / ↓      - Next channel
# k / ↑      - Previous channel
# PgUp       - Scroll messages up (history)
# PgDn       - Scroll messages down (latest)
# Enter      - Refresh messages (in normal mode)
# r / F5     - Full refresh (reload channels)
# Esc        - Cancel input / dismiss popup / return to normal mode
# l          - Open login dialog
# ?          - Show key binding help

## Example config (~/.config/wabi/config.toml)
# server_url = "https://chat.example.com"
# username = "ronin"

## Troubleshooting

# Terminal messed up after crash?
reset

# Or manually:
tput sgr0      # Reset colors
tput cnorm     # Show cursor

# Debug logging
RUST_LOG=debug ./target/release/wabi-tui 2>/tmp/wabi-tui.log

## Current Status
✅ Builds successfully
✅ First-run server URL prompt
✅ Connects to server (health check before login)
✅ Login with username + password (non-blocking background request)
✅ Displays channel list with auto-scroll
✅ Displays messages with PgUp/PgDn scrollback
✅ Send messages (requires login; instant optimistic display)
✅ Bearer auth on all API requests
✅ Keyboard navigation
✅ Panic-safe terminal cleanup

❌ No real-time updates (WebSocket polling — TODO)
