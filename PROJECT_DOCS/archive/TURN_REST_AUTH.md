# TURN REST Auth Migration

This project now uses backend-minted short-lived TURN credentials.

## Required Server Env (`.env`)

```env
TURN_EXTERNAL_IP=<public_turn_ip_or_host>
TURN_REALM=<your_turn_realm>
TURN_SHARED_SECRET=<long_random_secret>
TURN_CREDENTIAL_TTL_SECONDS=3600
```

`TURN_SHARED_SECRET` must be identical in backend and coturn.

## Frontend Env

Required:

```env
VITE_TURN_SERVER=<public_turn_ip_or_host>
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
```

Optional compatibility fallback only:

```env
VITE_TURN_USERNAME=<static_username>
VITE_TURN_PASSWORD=<static_password>
```

## Required coturn Config

```conf
use-auth-secret
static-auth-secret=${TURN_SHARED_SECRET}
realm=${TURN_REALM}
```

## Restart Commands

```sh
docker compose up -d --build backend frontend
docker compose --profile turn up -d --build coturn
```
