#!/usr/bin/env python3
"""Wabi shared Media Node controller.

One physical Media Node can pair independently with many Wabi Authorities. Each
Authority issues its own node id/secret. This controller keeps those credentials
isolated, heartbeats outbound to every Authority, advertises one physical SFU to
each, claims only media_relay jobs, activates tenant-scoped rooms, mints
short-lived backend tokens, and applies runtime participant permission changes
without handing SFU root secrets to an Authority.

This is intentionally dependency-free (Python stdlib only) so the operator path
can be wrapped by one Compose profile/command without introducing a hosted
control plane.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

STATE_VERSION = 1
USER_AGENT = "wabi-media-node/1"
DEFAULT_HEARTBEAT_SECONDS = 30.0
DEFAULT_POLL_SECONDS = 1.0
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_MEDIA_TOKEN_TTL_SECONDS = 600
MAX_MEDIA_TOKEN_TTL_SECONDS = 3600
ALLOWED_PUBLISH_SOURCES = {"camera", "microphone", "screen_share", "screen_share_audio"}


class ControllerError(RuntimeError):
    pass


class HttpStatusError(ControllerError):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:400]}")
        self.status = status
        self.body = body


def log(message: str) -> None:
    print(f"[wabi-media-node] {message}", flush=True)


def normalize_base_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if not (value.startswith("https://") or value.startswith("http://")):
        raise ControllerError("Authority URL must use http:// or https://")
    return value


def require_string(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ControllerError(f"config field {key!r} is required")
    return value.strip()


def optional_positive_int(obj: dict[str, Any], key: str) -> int | None:
    value = obj.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ControllerError(f"config field {key!r} must be a positive integer")
    return value


def load_json(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ControllerError(f"config not found: {path}") from exc
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ControllerError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ControllerError(f"{path} must contain a JSON object")
    return value


def atomic_write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    payload = json.dumps(value, indent=2, sort_keys=True) + "\n"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        finally:
            raise


def http_json(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    allow_no_content: bool = False,
) -> dict[str, Any] | None:
    encoded = None
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if body is not None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)

    request = Request(url, data=encoded, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read()
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        if allow_no_content and exc.code == 204:
            return None
        raise HttpStatusError(exc.code, raw) from exc
    except URLError as exc:
        raise ControllerError(f"network error contacting {url}: {exc.reason}") from exc

    if status == 204 and allow_no_content:
        return None
    if not raw:
        return {}
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ControllerError(f"non-JSON response from {url}") from exc
    if not isinstance(decoded, dict):
        raise ControllerError(f"unexpected JSON response shape from {url}")
    return decoded


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_hs256_jwt(claims: dict[str, Any], secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    encoded_header = _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    encoded_claims = _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{encoded_header}.{encoded_claims}".encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_claims}.{_b64url(signature)}"


def _validated_grants(payload: dict[str, Any]) -> tuple[bool, bool, bool, list[str]]:
    grants = payload.get("grants") or {}
    if not isinstance(grants, dict):
        raise ControllerError("media grants must be an object")
    can_publish = bool(grants.get("canPublish", False))
    can_subscribe = bool(grants.get("canSubscribe", True))
    can_publish_data = bool(grants.get("canPublishData", True))
    raw_sources = grants.get("canPublishSources") or []
    if not isinstance(raw_sources, list):
        raise ControllerError("canPublishSources must be an array")
    sources = [
        source for source in raw_sources
        if isinstance(source, str) and source in ALLOWED_PUBLISH_SOURCES
    ]
    if not can_publish:
        sources = []
    return can_publish, can_subscribe, can_publish_data, sources


def _livekit_http_base(endpoint: str) -> str:
    parsed = urlsplit(endpoint)
    scheme = {"wss": "https", "ws": "http"}.get(parsed.scheme, parsed.scheme)
    if scheme not in {"http", "https"} or not parsed.netloc:
        raise ControllerError("LiveKit endpoint cannot be converted to an HTTP API URL")
    return urlunsplit((scheme, parsed.netloc, "", "", "")).rstrip("/")


class MediaProfile:
    def __init__(self, config: dict[str, Any]):
        self.display_name = str(config.get("name") or "Wabi Media Node").strip()
        self.provider = require_string(config, "provider").lower()
        self.sfu_endpoint = require_string(config, "sfuEndpoint").rstrip("/")
        if not self.sfu_endpoint.startswith(("https://", "http://", "wss://", "ws://")):
            raise ControllerError("sfuEndpoint must use http(s) or ws(s)")
        region = config.get("region")
        self.region = region.strip() if isinstance(region, str) and region.strip() else None
        sharing = str(config.get("sharing") or "shared").strip().lower()
        if sharing not in {"private", "shared"}:
            raise ControllerError("sharing must be 'private' or 'shared'")
        self.sharing = sharing
        self.accepting_new_rooms = bool(config.get("acceptingNewRooms", True))

        capacity = config.get("capacity") or {}
        if not isinstance(capacity, dict):
            raise ControllerError("capacity must be a JSON object")
        self.max_rooms = optional_positive_int(capacity, "maxRooms")
        self.max_participants = optional_positive_int(capacity, "maxParticipants")
        self.max_participants_per_room = optional_positive_int(capacity, "maxParticipantsPerRoom")

        self.heartbeat_seconds = float(config.get("heartbeatSeconds", DEFAULT_HEARTBEAT_SECONDS))
        self.poll_seconds = float(config.get("pollSeconds", DEFAULT_POLL_SECONDS))
        if self.heartbeat_seconds < 5:
            raise ControllerError("heartbeatSeconds must be at least 5")
        if self.poll_seconds < 1:
            raise ControllerError("pollSeconds must be at least 1")

        self.livekit_api_key = os.environ.get("LIVEKIT_API_KEY", "").strip()
        self.livekit_api_secret = os.environ.get("LIVEKIT_API_SECRET", "").strip()

    def ensure_token_signing_ready(self) -> None:
        if self.provider != "livekit":
            return
        if not self.livekit_api_key or not self.livekit_api_secret:
            raise ControllerError(
                "LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required on a LiveKit Media Node"
            )
        if self.sharing == "shared" and (
            self.livekit_api_key == "disabled" or self.livekit_api_secret == "disabled"
        ):
            raise ControllerError("shared Media Nodes may not use the placeholder LiveKit key")

    def advertisement(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "region": self.region,
            "sharing": self.sharing,
            "sfuEndpoint": self.sfu_endpoint,
            "acceptingNewRooms": self.accepting_new_rooms,
            "maxRooms": self.max_rooms,
            "maxParticipants": self.max_participants,
            "maxParticipantsPerRoom": self.max_participants_per_room,
            "activeRooms": None,
            "activeParticipants": None,
        }

    def mint_livekit_token(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_token_signing_ready()
        if self.provider != "livekit":
            raise ControllerError(f"provider {self.provider!r} cannot mint a LiveKit token")

        external_room = payload.get("externalRoomName")
        identity = payload.get("identity")
        if not isinstance(external_room, str) or not external_room:
            raise ControllerError("mint_token job missing externalRoomName")
        if not isinstance(identity, str) or not identity:
            raise ControllerError("mint_token job missing identity")
        display_name = payload.get("displayName")
        if not isinstance(display_name, str) or not display_name.strip():
            display_name = identity
        display_name = display_name.strip()[:128]

        can_publish, can_subscribe, can_publish_data, sources = _validated_grants(payload)
        ttl = payload.get("ttlSeconds", DEFAULT_MEDIA_TOKEN_TTL_SECONDS)
        if not isinstance(ttl, int) or isinstance(ttl, bool):
            ttl = DEFAULT_MEDIA_TOKEN_TTL_SECONDS
        ttl = max(60, min(ttl, MAX_MEDIA_TOKEN_TTL_SECONDS))
        now = int(time.time())
        claims = {
            "iss": self.livekit_api_key,
            "sub": identity,
            "name": display_name,
            "nbf": now - 5,
            "iat": now,
            "exp": now + ttl,
            "video": {
                "roomJoin": True,
                "room": external_room,
                "canPublish": can_publish,
                "canSubscribe": can_subscribe,
                "canPublishData": can_publish_data,
                "canPublishSources": sources,
            },
        }
        token = sign_hs256_jwt(claims, self.livekit_api_secret)
        return {
            "token": token,
            "url": self.sfu_endpoint,
            "roomName": external_room,
            "identity": identity,
            "relayName": self.display_name,
            "source": "relay",
        }

    def _room_admin_token(self, room: str) -> str:
        self.ensure_token_signing_ready()
        now = int(time.time())
        return sign_hs256_jwt(
            {
                "iss": self.livekit_api_key,
                "sub": "wabi-media-node-admin",
                "nbf": now - 5,
                "iat": now,
                "exp": now + 60,
                "video": {"roomAdmin": True, "room": room},
            },
            self.livekit_api_secret,
        )

    def update_livekit_participant_permissions(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.provider != "livekit":
            raise ControllerError(f"provider {self.provider!r} cannot update LiveKit permissions")
        room = payload.get("externalRoomName")
        identity = payload.get("identity")
        if not isinstance(room, str) or not room:
            raise ControllerError("permission update missing externalRoomName")
        if not isinstance(identity, str) or not identity:
            raise ControllerError("permission update missing identity")
        can_publish, can_subscribe, can_publish_data, sources = _validated_grants(payload)
        body = {
            "room": room,
            "identity": identity,
            "permission": {
                "canPublish": can_publish,
                "canSubscribe": can_subscribe,
                "canPublishData": can_publish_data,
                "canPublishSources": sources,
            },
        }
        url = f"{_livekit_http_base(self.sfu_endpoint)}/twirp/livekit.RoomService/UpdateParticipant"
        try:
            http_json(
                "POST",
                url,
                body,
                {"Authorization": f"Bearer {self._room_admin_token(room)}"},
            )
        except HttpStatusError as exc:
            # A moderation event can race a participant that has not connected
            # yet or just disconnected. Future join tokens already carry the
            # new durable Wabi policy, so 'not found' is safely idempotent.
            if exc.status == 404 or "not found" in exc.body.lower():
                return {"acknowledged": True, "participantPresent": False, "identity": identity}
            raise
        return {"acknowledged": True, "participantPresent": True, "identity": identity}


class PairingStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.data = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "version": STATE_VERSION,
                "physicalPublicKey": f"wabi-media-{secrets.token_hex(32)}",
                "pairings": {},
            }
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ControllerError(f"cannot read pairing state {self.path}: {exc}") from exc
        if not isinstance(value, dict) or not isinstance(value.get("pairings"), dict):
            raise ControllerError(f"invalid pairing state in {self.path}")
        value.setdefault("version", STATE_VERSION)
        value.setdefault("physicalPublicKey", f"wabi-media-{secrets.token_hex(32)}")
        return value

    @property
    def physical_public_key(self) -> str:
        return str(self.data["physicalPublicKey"])

    def get(self, authority_url: str) -> dict[str, Any] | None:
        with self._lock:
            value = self.data["pairings"].get(authority_url)
            return dict(value) if isinstance(value, dict) else None

    def put(self, authority_url: str, pairing: dict[str, Any]) -> None:
        with self._lock:
            self.data["pairings"][authority_url] = pairing
            atomic_write_private_json(self.path, self.data)


class AuthoritySession:
    def __init__(
        self,
        authority_config: dict[str, Any],
        pairing: dict[str, Any],
        profile: MediaProfile,
        stop: threading.Event,
    ):
        self.config = authority_config
        self.pairing = pairing
        self.profile = profile
        self.stop = stop
        self.url = normalize_base_url(str(pairing["authorityUrl"]))
        self.node_id = str(pairing["nodeId"])
        self.node_secret = str(pairing["nodeSecret"])
        self.label = str(authority_config.get("name") or self.url)

    @property
    def node_headers(self) -> dict[str, str]:
        return {"x-wabi-node-secret": self.node_secret}

    def heartbeat(self) -> None:
        http_json(
            "POST",
            f"{self.url}/api/nodes/{quote(self.node_id, safe='')}/heartbeat",
            {
                "load": {},
                "reachability": "public_reachable",
                "endpoint": self.profile.sfu_endpoint,
                "capabilities": ["media_relay"],
                "lanReachableAt": None,
            },
            self.node_headers,
        )

    def advertise(self) -> None:
        http_json(
            "POST",
            f"{self.url}/api/nodes/{quote(self.node_id, safe='')}/media-advertisement",
            self.profile.advertisement(),
            self.node_headers,
        )

    def claim_job(self) -> dict[str, Any] | None:
        return http_json(
            "POST",
            f"{self.url}/api/jobs/claim",
            {
                "nodeId": self.node_id,
                "nodeSecret": self.node_secret,
                "capabilities": ["media_relay"],
            },
            allow_no_content=True,
        )

    def report_job(
        self,
        job_id: str,
        success: bool,
        result_payload: dict[str, Any] | None = None,
        error_message: str | None = None,
    ) -> None:
        http_json(
            "POST",
            f"{self.url}/api/jobs/{quote(job_id, safe='')}/result",
            {
                "nodeId": self.node_id,
                "nodeSecret": self.node_secret,
                "success": success,
                "resultPayload": result_payload,
                "errorMessage": error_message,
            },
        )

    def _validate_target(self, payload: dict[str, Any]) -> None:
        assigned = payload.get("assignedNodeId")
        if assigned is not None and assigned != self.node_id:
            raise ControllerError("media_relay job is targeted at a different node")

    def activate_room(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._validate_target(payload)
        room_id = payload.get("roomId")
        if not isinstance(room_id, str) or not room_id:
            raise ControllerError("activate_room job missing roomId")
        tenant = payload.get("tenantNamespace")
        external_room = payload.get("externalRoomName")
        if not isinstance(external_room, str) or not external_room:
            external_room = room_id

        http_json(
            "POST",
            f"{self.url}/api/media/rooms/{quote(room_id, safe='')}/active",
            {"nodeId": self.node_id, "sfuEndpoint": self.profile.sfu_endpoint},
            self.node_headers,
        )
        return {
            "acknowledged": True,
            "roomId": room_id,
            "tenantNamespace": tenant,
            "externalRoomName": external_room,
            "provider": self.profile.provider,
            "sfuEndpoint": self.profile.sfu_endpoint,
        }

    def mint_token(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._validate_target(payload)
        return self.profile.mint_livekit_token(payload)

    def update_participant_permissions(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._validate_target(payload)
        return self.profile.update_livekit_participant_permissions(payload)

    def run(self) -> None:
        log(f"{self.label}: session started as node {self.node_id}")
        next_heartbeat = 0.0
        next_advertisement = 0.0
        while not self.stop.is_set():
            now = time.monotonic()
            try:
                if now >= next_heartbeat:
                    self.heartbeat()
                    next_heartbeat = now + self.profile.heartbeat_seconds
                if now >= next_advertisement:
                    self.advertise()
                    next_advertisement = now + self.profile.heartbeat_seconds
                job = self.claim_job()
                if job:
                    self.handle_job(job)
            except HttpStatusError as exc:
                if exc.status in {401, 403}:
                    log(f"{self.label}: pairing rejected/revoked; stopping this Authority session")
                    return
                log(f"{self.label}: HTTP error: {exc}")
            except ControllerError as exc:
                log(f"{self.label}: {exc}")
            except Exception as exc:
                log(f"{self.label}: unexpected error: {type(exc).__name__}: {exc}")
            self.stop.wait(self.profile.poll_seconds)

    def handle_job(self, job: dict[str, Any]) -> None:
        job_id = job.get("jobId")
        kind = job.get("kind")
        payload = job.get("payload")
        if not isinstance(job_id, str) or not job_id:
            raise ControllerError("claimed job missing jobId")
        if kind != "media_relay" or not isinstance(payload, dict):
            self.report_job(job_id, False, error_message="unsupported job for media node")
            return

        operation = payload.get("operation") or "activate_room"
        try:
            if operation == "activate_room":
                result = self.activate_room(payload)
            elif operation == "mint_token":
                result = self.mint_token(payload)
            elif operation == "update_participant_permissions":
                result = self.update_participant_permissions(payload)
            else:
                raise ControllerError(f"unsupported media operation: {operation}")
        except Exception as exc:
            self.report_job(job_id, False, error_message=str(exc)[:500])
            raise
        else:
            self.report_job(job_id, True, result_payload=result)
            if operation == "activate_room":
                log(f"{self.label}: activated room {result['roomId']} as {result['externalRoomName']}")
            elif operation == "mint_token":
                log(f"{self.label}: minted scoped token for {result['identity']}")
            else:
                log(f"{self.label}: refreshed media permissions for {result['identity']}")


def pair_authority(
    authority: dict[str, Any],
    profile: MediaProfile,
    store: PairingStore,
) -> dict[str, Any] | None:
    url = normalize_base_url(require_string(authority, "url"))
    existing = store.get(url)
    if existing:
        return existing

    token = authority.get("pairingToken")
    if not isinstance(token, str) or not token.strip():
        log(f"{url}: no saved pairing and no pairingToken; skipping")
        return None

    label = str(authority.get("name") or profile.display_name).strip()
    response = http_json(
        "POST",
        f"{url}/api/nodes/join",
        {
            "token": token.strip(),
            "displayName": label,
            "publicKey": store.physical_public_key,
            "reachability": "public_reachable",
            "endpoint": profile.sfu_endpoint,
        },
    )
    if not response:
        raise ControllerError(f"{url}: empty join response")
    node = response.get("node")
    if not isinstance(node, dict):
        raise ControllerError(f"{url}: join response missing node")
    node_id = node.get("nodeId")
    node_secret = response.get("nodeSecret")
    authority_node_id = response.get("authorityNodeId")
    if not all(isinstance(v, str) and v for v in (node_id, node_secret, authority_node_id)):
        raise ControllerError(f"{url}: incomplete join response")

    pairing = {
        "authorityUrl": url,
        "authorityNodeId": authority_node_id,
        "nodeId": node_id,
        "nodeSecret": node_secret,
        "displayName": label,
    }
    store.put(url, pairing)
    log(f"{url}: paired as node {node_id}; the one-time pairingToken can now be removed")
    return pairing


def validate_config(config: dict[str, Any]) -> tuple[MediaProfile, list[dict[str, Any]]]:
    profile = MediaProfile(config)
    authorities = config.get("authorities")
    if not isinstance(authorities, list) or not authorities:
        raise ControllerError("config must include a non-empty authorities array")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(authorities):
        if not isinstance(entry, dict):
            raise ControllerError(f"authorities[{index}] must be an object")
        url = normalize_base_url(require_string(entry, "url"))
        if url in seen:
            raise ControllerError(f"duplicate Authority URL: {url}")
        seen.add(url)
        copy = dict(entry)
        copy["url"] = url
        normalized.append(copy)
    return profile, normalized


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one Wabi Media Node for many Authorities")
    parser.add_argument("--config", default="wabi.media-node.json", help="media-node JSON config")
    parser.add_argument(
        "--state-dir",
        default="data/wabi-media-node",
        help="private local state directory (default: data/wabi-media-node)",
    )
    parser.add_argument("--check", action="store_true", help="validate config and exit")
    args = parser.parse_args()

    try:
        config = load_json(Path(args.config))
        profile, authorities = validate_config(config)
    except ControllerError as exc:
        log(str(exc))
        return 2

    if args.check:
        token_state = "ready" if (profile.livekit_api_key and profile.livekit_api_secret) else "not configured"
        log(
            f"config valid: provider={profile.provider} endpoint={profile.sfu_endpoint} "
            f"authorities={len(authorities)} token-signing={token_state}"
        )
        return 0

    try:
        profile.ensure_token_signing_ready()
    except ControllerError as exc:
        log(str(exc))
        return 2

    state_dir = Path(args.state_dir)
    store = PairingStore(state_dir / "pairings.json")
    if not store.path.exists():
        atomic_write_private_json(store.path, store.data)

    pairings: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for authority in authorities:
        try:
            pairing = pair_authority(authority, profile, store)
        except ControllerError as exc:
            log(str(exc))
            continue
        if pairing:
            pairings.append((authority, pairing))

    if not pairings:
        log("no usable Authority pairings; nothing to serve")
        return 1

    stop = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    threads: list[threading.Thread] = []
    for authority, pairing in pairings:
        session = AuthoritySession(authority, pairing, profile, stop)
        thread = threading.Thread(
            target=session.run,
            name=f"wabi-media-{session.node_id}",
            daemon=True,
        )
        thread.start()
        threads.append(thread)

    log(
        f"serving {len(threads)} independent Wabi Authorities through "
        f"{profile.provider} at {profile.sfu_endpoint}"
    )
    try:
        while not stop.wait(1.0):
            if not any(thread.is_alive() for thread in threads):
                log("all Authority sessions stopped")
                return 1
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
