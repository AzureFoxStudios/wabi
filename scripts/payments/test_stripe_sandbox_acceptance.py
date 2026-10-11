#!/usr/bin/env python3
"""Offline guards for the provider harness; no keys, network, or funds needed."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("stripe_acceptance", Path(__file__).with_name("stripe-sandbox-acceptance.py"))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


IDENTITY = {"authenticated": True, "account_id": "acct_SyntheticOnly",
            "test_mode_key": {"available": True}, "live_mode_key": {"available": False}}


class ProfileGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wabi-stripe-offline-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.directory.chmod(0o700)
        self.config = self.directory / "profile.json"
        self.log = self.directory / "calls.private.jsonl"
        self.cli = self.directory / "fake-stripe"
        self.cli.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
config = pathlib.Path(args[args.index('--config') + 1])
data = json.loads(config.read_text())
with open(config.with_name('calls.private.jsonl'), 'a') as log:
    log.write(json.dumps({'args': args, 'ambient_key_present': 'STRIPE_API_KEY' in os.environ}) + '\\n')
if 'whoami' in args:
    print(json.dumps(data['identity']))
else:
    print(json.dumps(data.get('response', {'livemode': False})))
""")
        self.cli.chmod(0o700)

    def sandbox(self, identity=IDENTITY, response=None):
        self.config.write_text(json.dumps({"identity": identity, "response": response}))
        self.config.chmod(0o600)
        args = argparse.Namespace(cli=str(self.cli), config=str(self.config), project="synthetic-only")
        return acceptance.Sandbox(args, self.directory)

    def calls(self):
        return [json.loads(row) for row in self.log.read_text().splitlines()]

    def assert_refused_before_mutation(self, identity):
        sandbox = self.sandbox(identity)
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.prepare(sandbox)
        calls = self.calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("whoami", calls[0]["args"])
        self.assertNotIn("post", calls[0]["args"])

    def test_live_profile_refused_before_mutation(self):
        self.assert_refused_before_mutation({**IDENTITY, "live_mode_key": {"available": True}})

    def test_missing_live_mode_proof_refused_before_mutation(self):
        for value in ({}, {"available": None}, {"available": 0}, {"available": "false"}, None):
            with self.subTest(live_key=value):
                self.assert_refused_before_mutation({**IDENTITY, "live_mode_key": value})
                self.log.unlink()

    def test_missing_or_truthy_test_proof_refused_before_mutation(self):
        for value in ({}, {"available": False}, {"available": 1}, {"available": "true"}, None):
            with self.subTest(test_key=value):
                self.assert_refused_before_mutation({**IDENTITY, "test_mode_key": value})
                self.log.unlink()

    def test_unauthenticated_and_truthy_authentication_refused(self):
        for value in (False, None, 1, "true"):
            with self.subTest(authenticated=value):
                self.assert_refused_before_mutation({**IDENTITY, "authenticated": value})
                self.log.unlink()

    def test_missing_account_refused_before_mutation(self):
        self.assert_refused_before_mutation({**IDENTITY, "account_id": None})

    def test_explicit_profile_and_ambient_key_isolation(self):
        with mock.patch.dict(os.environ, {"STRIPE_API_KEY": "synthetic-canary-do-not-transmit"}):
            sandbox = self.sandbox()
        self.assertEqual(sandbox.authenticate(), IDENTITY)
        call = self.calls()[0]
        self.assertFalse(call["ambient_key_present"])
        self.assertIn("--config", call["args"])
        self.assertIn(str(self.config), call["args"])
        self.assertIn("synthetic-only", call["args"])
        self.assertNotIn("--live", call["args"])
        self.assertNotIn("--api-key", call["args"])

    def test_private_artifacts_are_owner_only(self):
        sandbox = self.sandbox()
        sandbox.authenticate()
        self.assertEqual((self.directory / "request-01.private.json").stat().st_mode & 0o777, 0o600)

    def test_live_or_malformed_object_refused(self):
        for value in (True, None, 1, "false"):
            with self.subTest(livemode=value):
                sandbox = self.sandbox(response={"livemode": value})
                with self.assertRaises(acceptance.AcceptanceError):
                    sandbox.call(["get", "/v1/prices"])

    def test_json_array_is_not_a_provider_object(self):
        sandbox = self.sandbox(response=[])
        with self.assertRaisesRegex(acceptance.AcceptanceError, "unexpected JSON shape"):
            sandbox.call(["get", "/v1/prices"])


class HostedAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wabi-hosted-offline-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.state_path = Path(self.temp.name) / "state.private.json"
        self.state = {"account_id": IDENTITY["account_id"], "run_id": "synthetic-run",
                      "sessions": {case: {"id": f"cs_test_{case}"} for case in ("success", "decline")}}
        self.state_path.write_text(json.dumps(self.state))

    def fixture(self, paid=True, attempted_decline=True):
        sandbox = mock.Mock()
        sandbox.authenticate.return_value = IDENTITY
        sandbox.require_test.side_effect = lambda value: value

        def response(command):
            case = "success" if command[1].endswith("success") else "decline"
            if command[1].startswith("/v1/checkout/sessions/"):
                session = {"livemode": False, "amount_total": 100, "currency": "usd",
                           "metadata": {"acceptance_run": "synthetic-run", "acceptance_case": case},
                           "status": "complete" if case == "success" and paid else "open",
                           "payment_status": "paid" if case == "success" and paid else "unpaid"}
                if case == "success" and paid or case == "decline" and attempted_decline:
                    session["payment_intent"] = f"pi_{case}"
                return session
            return {"livemode": False, "amount": 100, "currency": "usd",
                    "status": "succeeded" if case == "success" else "requires_payment_method",
                    "last_payment_error": None if case == "success" else {"code": "card_declined", "decline_code": "generic_decline"}}

        sandbox.call.side_effect = response
        return sandbox

    def test_prepared_sessions_do_not_count_as_hosted_acceptance(self):
        sandbox = self.fixture(paid=False, attempted_decline=False)
        result = acceptance.verify(sandbox, self.state_path)
        self.assertEqual(result["hosted_checkout_acceptance"], "pending")
        with self.assertRaisesRegex(acceptance.AcceptanceError, "incomplete"):
            acceptance.verify(sandbox, self.state_path, require_hosted=True)

    def test_success_and_documented_decline_are_required(self):
        result = acceptance.verify(self.fixture(), self.state_path, require_hosted=True)
        self.assertEqual(result["hosted_checkout_acceptance"], "passed")

    def test_paid_success_without_decline_attempt_is_incomplete(self):
        with self.assertRaisesRegex(acceptance.AcceptanceError, "incomplete"):
            acceptance.verify(self.fixture(attempted_decline=False), self.state_path, require_hosted=True)

    def test_foreign_account_or_live_session_state_refused(self):
        for alteration in ({"account_id": "acct_Other"}, {"sessions": {"success": {"id": "cs_live_unsafe"}, "decline": {"id": "cs_test_decline"}}}):
            with self.subTest(state=alteration):
                self.state_path.write_text(json.dumps({**self.state, **alteration}))
                with self.assertRaises(acceptance.AcceptanceError):
                    acceptance.verify(self.fixture(), self.state_path)

    def test_wrong_currency_refused(self):
        sandbox = self.fixture()
        sandbox.call.side_effect = None
        sandbox.call.return_value = {"livemode": False, "amount_total": 100, "currency": "eur",
                                    "metadata": {"acceptance_run": "synthetic-run", "acceptance_case": "success"}}
        with self.assertRaisesRegex(acceptance.AcceptanceError, "binding or amount"):
            acceptance.verify(sandbox, self.state_path)


if __name__ == "__main__":
    unittest.main()
