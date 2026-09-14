from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "wabi-media-node.py"
SPEC = importlib.util.spec_from_file_location("wabi_media_node", SCRIPT)
assert SPEC and SPEC.loader
media_node = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media_node)


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


if __name__ == "__main__":
    unittest.main()
