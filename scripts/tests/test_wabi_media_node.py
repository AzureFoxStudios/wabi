from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import threading
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "wabi-media-node.py"
SPEC = importlib.util.spec_from_file_location("wabi_media_node", SCRIPT)
assert SPEC and SPEC.loader
media_node = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media_node)


def decode_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    assert len(parts) == 3
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))


@contextmanager
def permission_server(response_body=None, redirect=None):
    received = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, dict(self.headers), json.loads(
                self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(307 if redirect else 200)
            if redirect:
                self.send_header("Location", redirect)
            self.end_headers()
            if not redirect:
                self.wfile.write(response_body if response_body is not None else
                    json.dumps({"identity": "user:42"}).encode())
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class MediaNodeControllerTests(unittest.TestCase):
    def profile_config(self):
        return {
            "name": "Test Node",
            "provider": "livekit",
            "sfuEndpoint": "wss://calls.example.test/",
            "region": "test-region",
            "sharing": "shared",
            "capacity": {
                "maxRooms": 10,
                "maxParticipants": 100,
                "maxParticipantsPerRoom": 50,
            },
            "authorities": [{"url": "https://a.example.test", "pairingToken": "once"}],
        }

    def test_profile_normalizes_endpoint_and_advertises_unknown_occupancy(self):
        profile = media_node.MediaProfile(self.profile_config())
        self.assertEqual(profile.provider, "livekit")
        self.assertEqual(profile.sfu_endpoint, "wss://calls.example.test")
        ad = profile.advertisement()
        self.assertEqual(ad["sharing"], "shared")
        self.assertEqual(ad["maxParticipants"], 100)
        self.assertIsNone(ad["activeRooms"])
        self.assertIsNone(ad["activeParticipants"])

    def test_duplicate_authority_urls_are_rejected(self):
        config = self.profile_config()
        config["authorities"].append({"url": "https://a.example.test/"})
        with self.assertRaises(media_node.ControllerError):
            media_node.validate_config(config)

    def test_pairing_store_keeps_physical_key_and_independent_authorities(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pairings.json"
            store = media_node.PairingStore(path)
            key = store.physical_public_key
            store.put(
                "https://a.example.test",
                {
                    "authorityUrl": "https://a.example.test",
                    "authorityNodeId": "authority-a",
                    "nodeId": "node-a",
                    "nodeSecret": "secret-a",
                    "displayName": "A",
                },
            )
            store.put(
                "https://b.example.test",
                {
                    "authorityUrl": "https://b.example.test",
                    "authorityNodeId": "authority-b",
                    "nodeId": "node-b",
                    "nodeSecret": "secret-b",
                    "displayName": "B",
                },
            )

            reopened = media_node.PairingStore(path)
            self.assertEqual(reopened.physical_public_key, key)
            self.assertEqual(reopened.get("https://a.example.test")["nodeSecret"], "secret-a")
            self.assertEqual(reopened.get("https://b.example.test")["nodeSecret"], "secret-b")
            self.assertNotEqual(
                reopened.get("https://a.example.test")["nodeSecret"],
                reopened.get("https://b.example.test")["nodeSecret"],
            )

    def test_pair_authority_uses_stable_physical_key_and_does_not_store_token(self):
        config = self.profile_config()
        profile = media_node.MediaProfile(config)
        authority = config["authorities"][0]
        with tempfile.TemporaryDirectory() as tmp:
            store = media_node.PairingStore(Path(tmp) / "pairings.json")
            response = {
                "node": {"nodeId": "node-a"},
                "nodeSecret": "secret-a",
                "authorityNodeId": "authority-a",
            }
            with mock.patch.object(media_node, "http_json", return_value=response) as request:
                pairing = media_node.pair_authority(authority, profile, store)

            sent = request.call_args.args[2]
            self.assertEqual(sent["publicKey"], store.physical_public_key)
            self.assertEqual(pairing["nodeSecret"], "secret-a")
            persisted = json.loads((Path(tmp) / "pairings.json").read_text())
            self.assertNotIn("pairingToken", json.dumps(persisted))

    def test_activate_room_uses_node_secret_and_tenant_scoped_name(self):
        config = self.profile_config()
        profile = media_node.MediaProfile(config)
        stop = __import__("threading").Event()
        session = media_node.AuthoritySession(
            {"name": "A"},
            {
                "authorityUrl": "https://a.example.test",
                "nodeId": "node-a",
                "nodeSecret": "secret-a",
                "authorityNodeId": "authority-a",
            },
            profile,
            stop,
        )
        with mock.patch.object(media_node, "http_json", return_value={}) as request:
            result = session.activate_room(
                {
                    "roomId": "room-local",
                    "tenantNamespace": "tenant-opaque",
                    "externalRoomName": "wabi-tenant-opaque-room-local",
                    "assignedNodeId": "node-a",
                }
            )

        self.assertEqual(result["externalRoomName"], "wabi-tenant-opaque-room-local")
        self.assertEqual(request.call_args.args[3]["x-wabi-node-secret"], "secret-a")
        self.assertIn("/api/media/rooms/room-local/active", request.call_args.args[1])

    def test_activate_room_rejects_job_targeted_at_other_node(self):
        profile = media_node.MediaProfile(self.profile_config())
        session = media_node.AuthoritySession(
            {},
            {
                "authorityUrl": "https://a.example.test",
                "nodeId": "node-a",
                "nodeSecret": "secret-a",
                "authorityNodeId": "authority-a",
            },
            profile,
            __import__("threading").Event(),
        )
        with self.assertRaises(media_node.ControllerError):
            session.activate_room(
                {
                    "roomId": "room-local",
                    "externalRoomName": "opaque",
                    "assignedNodeId": "node-b",
                }
            )

    def test_livekit_token_is_scoped_to_exact_room_identity_and_grants(self):
        with mock.patch.dict(
            os.environ,
            {"LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": "test-secret"},
            clear=False,
        ):
            profile = media_node.MediaProfile(self.profile_config())
            before = int(time.time())
            result = profile.mint_livekit_token(
                {
                    "externalRoomName": "wabi-tenant-123-room-456",
                    "identity": "user:42",
                    "displayName": "Alice",
                    "ttlSeconds": 900,
                    "grants": {
                        "canPublish": False,
                        "canSubscribe": True,
                        "canPublishData": True,
                        # A muted caller cannot smuggle sources through the list.
                        "canPublishSources": ["microphone", "camera"],
                    },
                }
            )

        claims = decode_jwt_payload(result["token"])
        self.assertEqual(claims["iss"], "test-key")
        self.assertEqual(claims["sub"], "user:42")
        self.assertEqual(claims["name"], "Alice")
        self.assertEqual(claims["video"]["room"], "wabi-tenant-123-room-456")
        self.assertTrue(claims["video"]["roomJoin"])
        self.assertFalse(claims["video"]["canPublish"])
        self.assertTrue(claims["video"]["canSubscribe"])
        self.assertEqual(claims["video"]["canPublishSources"], [])
        self.assertGreaterEqual(claims["exp"], before + 895)
        self.assertLessEqual(claims["exp"], before + 905)
        self.assertEqual(result["roomName"], "wabi-tenant-123-room-456")
        self.assertEqual(result["url"], "wss://calls.example.test")

    def test_shared_livekit_node_rejects_placeholder_root_credentials(self):
        with mock.patch.dict(
            os.environ,
            {"LIVEKIT_API_KEY": "disabled", "LIVEKIT_API_SECRET": "disabled"},
            clear=False,
        ):
            profile = media_node.MediaProfile(self.profile_config())
            with self.assertRaises(media_node.ControllerError):
                profile.ensure_token_signing_ready()

    def permission_session(self, endpoint):
        config = self.profile_config()
        config["sfuEndpoint"] = endpoint
        with mock.patch.dict(os.environ, {
            "LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": "test-secret"
        }):
            profile = media_node.MediaProfile(config)
        session = media_node.AuthoritySession({}, {
            "authorityUrl": "https://authority.example.test", "nodeId": "node-a",
            "nodeSecret": "node-secret", "authorityNodeId": "authority-a"
        }, profile, threading.Event())
        return session

    def permission_payload(self):
        return {"operation": "update_participant_permissions", "assignedNodeId": "node-a",
            "roomId": "room-local", "externalRoomName": "wabi-tenant-a-room-local",
            "identity": "user:42", "grants": {"canPublish": False,
                "canSubscribe": False, "canPublishData": False,
                "canPublishSources": ["microphone"]}}

    def test_permission_job_uses_real_rpc_and_room_scoped_signature(self):
        with permission_server() as (endpoint, received):
            session = self.permission_session(endpoint)
            payload = self.permission_payload()
            # A job must not redirect backend credentials to a chosen endpoint.
            payload["sfuEndpoint"] = "https://untrusted.example.test"
            with mock.patch.object(session, "report_job") as report:
                session.handle_job({"jobId": "job-1", "kind": "media_relay", "payload": payload})
            report.assert_called_once_with("job-1", True, result_payload={
                "updated": True, "identity": "user:42", "roomName": "wabi-tenant-a-room-local"})
        self.assertEqual(len(received), 1)
        path, headers, body = received[0]
        self.assertEqual(path, "/twirp/livekit.RoomService/UpdateParticipant")
        self.assertEqual(body, {"room": payload["externalRoomName"], "identity": "user:42",
            "permission": {"canPublish": False, "canSubscribe": False,
                "canPublishData": False, "canPublishSources": []}})
        token = headers["Authorization"].removeprefix("Bearer ")
        claims = decode_jwt_payload(token)
        self.assertEqual(claims["video"], {"roomAdmin": True, "room": payload["externalRoomName"]})
        self.assertEqual(claims["exp"] - claims["iat"], 60)
        first, second, signature = token.split(".")
        expected = base64.urlsafe_b64encode(hmac.new(b"test-secret",
            f"{first}.{second}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
        self.assertEqual(signature, expected)

    def test_permission_rpc_refuses_redirect_without_credential_replay(self):
        with permission_server() as (other, replayed):
            with permission_server(redirect=other + "/escape") as (endpoint, received):
                session = self.permission_session(endpoint)
                with mock.patch.object(session, "report_job") as report:
                    with self.assertRaises(media_node.ControllerError):
                        session.handle_job({"jobId": "job-1", "kind": "media_relay",
                            "payload": self.permission_payload()})
                self.assertFalse(report.call_args.args[1])
        self.assertEqual(len(received), 1)
        self.assertEqual(replayed, [])

    def test_permission_rpc_requires_matching_node_strict_grants_and_bounded_identity_response(self):
        with permission_server() as (endpoint, received):
            session = self.permission_session(endpoint)
            for change in ["node", "boolean", "source"]:
                payload = self.permission_payload()
                if change == "node":
                    payload["assignedNodeId"] = "node-b"
                elif change == "boolean":
                    payload["grants"]["canPublish"] = "false"
                else:
                    payload["grants"]["canPublishSources"] = ["invented"]
                with self.assertRaises(media_node.ControllerError):
                    session.update_participant_permissions(payload)
            self.assertEqual(received, [])
        for raw in [b'{"identity":"someone-else"}', b"not JSON",
                    b"x" * (media_node.MAX_PERMISSION_RESPONSE_BYTES + 1)]:
            with permission_server(response_body=raw) as (endpoint, _received):
                with self.assertRaises(media_node.ControllerError):
                    self.permission_session(endpoint).update_participant_permissions(self.permission_payload())

    def test_permission_rpc_maps_allowed_sources_to_protocol_enum(self):
        with permission_server() as (endpoint, received):
            payload = self.permission_payload()
            payload["grants"]["canPublish"] = True
            payload["grants"]["canPublishSources"] = ["microphone", "screen_share"]
            self.permission_session(endpoint).update_participant_permissions(payload)
        self.assertEqual(received[0][2]["permission"]["canPublishSources"],
            ["MICROPHONE", "SCREEN_SHARE"])

    def test_authority_requests_refuse_credential_redirects_and_oversized_responses(self):
        with permission_server() as (other, replayed):
            with permission_server(redirect=other + "/escape") as (endpoint, received):
                with self.assertRaises(media_node.HttpStatusError) as error:
                    media_node.http_json("POST", endpoint, {"nodeSecret":"fixture-secret"},
                        {"x-wabi-node-secret":"fixture-secret"})
                self.assertNotIn("fixture-secret", str(error.exception))
        self.assertEqual(len(received), 1)
        self.assertEqual(replayed, [])
        with permission_server(response_body=b"x" * (media_node.MAX_PERMISSION_RESPONSE_BYTES + 1)) as (endpoint, _):
            with self.assertRaises(media_node.ControllerError):
                media_node.http_json("POST", endpoint, {})


if __name__ == "__main__":
    unittest.main()
