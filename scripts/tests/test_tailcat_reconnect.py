"""Offline contract checks against the immutable real-network evidence."""
import copy
import importlib.util
import json
import re
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reconnect', ROOT / 'scripts/tailcat/reconnect_regression.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
EVIDENCE = json.loads((ROOT / 'docs/testing/tailcat-janya-2026-09-21/followup-results.json').read_text())


class ReconnectContract(unittest.TestCase):
    def setUp(self):
        self.direct = copy.deepcopy(EVIDENCE['counters-fresh-server'])
        self.relay = copy.deepcopy(EVIDENCE['counters-normal'])

    def test_counter_builder_tracks_shipped_revision(self):
        fetch = (ROOT / 'scripts/fetch-tailcat-sidecar.sh').read_text()
        builder = (ROOT / 'scripts/tailcat/build_counter_client.py').read_text()
        shipped = re.search(r'TAILCAT_COMMIT="([0-9a-f]+)"', fetch).group(1)
        diagnostic = re.search(r"REVISION = '([0-9a-f]+)'", builder).group(1)
        self.assertEqual(diagnostic, shipped, 'Update and revalidate the field client with each sidecar revision')

    def test_actual_regression_is_failure_not_expected_pass(self):
        self.assertEqual(r.verdict(self.direct, self.relay)[0], 1)

    def test_permanent_runner_capture_is_also_rejected(self):
        saved = json.loads((ROOT / 'docs/testing/tailcat-janya-2026-09-21/permanent-runner-results.json').read_text())
        self.assertTrue(saved['cleanup'])
        self.assertEqual(r.verdict(saved['sessions']['fresh'], saved['sessions']['reconnect'])[0], 1)

    def test_direct_both_sessions_pass(self):
        self.assertEqual(r.verdict(self.direct, self.direct)[0], 0)

    def test_failed_baseline_is_inconclusive_not_reconnect_failure(self):
        self.assertEqual(r.verdict(self.relay, self.direct)[0], 2)

    def test_route_probe_without_byte_counters_cannot_pass(self):
        self.assertFalse(r.direct_payload(EVIDENCE['fresh-baseline']))

    def test_corruption_cannot_pass_even_with_direct_counters(self):
        self.direct['transfers'][1]['sha256_matches'] = False
        self.assertEqual(r.verdict(self.direct, self.direct)[0], 2)

    def test_missing_partial_negative_and_insufficient_counters_fail(self):
        for value in [None, {}, {'rx_direct_v4': r.SIZE * r.COUNT},
                      {k: -1 for k in r.FIELDS}, {k: 0 for k in r.FIELDS}]:
            with self.subTest(value=value):
                self.direct['final_tunnel_byte_counters'] = value
                self.assertFalse(r.direct_payload(self.direct))

    def test_mixed_incoming_path_does_not_claim_direct_only_payload(self):
        self.direct['final_tunnel_byte_counters']['rx_derp'] = 1
        self.assertFalse(r.direct_payload(self.direct))

    def test_counter_parser_requires_all_fields_and_uses_last_sample(self):
        text = 'FIELD counters: map[rx_derp:0 rx_direct_v4:5 tx_derp:2 tx_direct_v4:1]\n'
        text += 'FIELD counters: map[rx_derp:0 rx_direct_v4:99 tx_derp:3 tx_direct_v4:8]'
        self.assertEqual(r.counters(text)['rx_direct_v4'], 99)
        for bad in ['', 'pong via direct', 'FIELD counters: map[rx_derp:0]']:
            with self.assertRaises(ValueError):
                r.counters(bad)


class BoundaryContract(unittest.TestCase):
    def setUp(self):
        self.meta = {'port': 3002, 'unrelated_port': 43210, 'lan_address': '192.0.2.2'}

    def test_allowed_control_and_denials(self):
        with patch.object(r, 'socks_connect', side_effect=[0, 2, 2, 2, 2, 2, 2, 0]):
            rows = r.boundary_probes(12345, self.meta)
        self.assertTrue(rows[0]['connected'])
        self.assertTrue(all(not row['connected'] for row in rows[1:]))

    def test_any_forbidden_tcp_success_aborts_even_without_http_payload(self):
        for forbidden in range(1, 7):
            replies = [0] + [2] * 6
            replies[forbidden] = 0
            with self.subTest(forbidden=forbidden), patch.object(r, 'socks_connect', side_effect=replies):
                with self.assertRaisesRegex(RuntimeError, 'BOUNDARY ESCAPE'):
                    r.boundary_probes(12345, self.meta)

    def test_dead_allowed_control_cannot_certify_boundary(self):
        with patch.object(r, 'socks_connect', return_value=2):
            with self.assertRaisesRegex(RuntimeError, 'Allowed service unavailable'):
                r.boundary_probes(12345, self.meta)

    def test_protocol_failure_is_inconclusive_not_a_denial(self):
        with patch.object(r, 'socks_connect', side_effect=[0, ValueError('malformed')]):
            with self.assertRaisesRegex(RuntimeError, 'measurement failed'):
                r.boundary_probes(12345, self.meta)

    def test_other_lan_control_and_escape(self):
        self.meta['other_lan'] = {'host': '192.0.2.3', 'port': 80, 'reachable_from_server': True}
        with patch.object(r, 'socks_connect', side_effect=[0] + [2] * 6 + [0]):
            with self.assertRaisesRegex(RuntimeError, 'BOUNDARY ESCAPE: other-lan-live'):
                r.boundary_probes(12345, self.meta)
        self.meta['other_lan']['reachable_from_server'] = False
        with self.assertRaisesRegex(RuntimeError, 'positive control unavailable'):
            r.boundary_probes(12345, self.meta)


if __name__ == '__main__':
    unittest.main()
