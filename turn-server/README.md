# TURN Server (coturn) for Wabi

This directory contains Dockerized `coturn` configuration for WebRTC media relay.

## Required Auth Mode

This project now uses TURN REST auth (short-lived credentials minted by backend), not static TURN usernames/passwords.

Required `coturn` directives:

```conf
use-auth-secret
static-auth-secret=<same value as backend TURN_SHARED_SECRET>
realm=<same value as TURN_REALM>
```

These directives are already set in `turnserver.conf.template` using environment variables.

## Required Environment

- `TURN_EXTERNAL_IP`
- `TURN_REALM`
- `TURN_SHARED_SECRET` (must match backend `TURN_SHARED_SECRET`)

## Run with Docker Compose

From repo root:

```sh
docker compose --profile turn up -d coturn
```
