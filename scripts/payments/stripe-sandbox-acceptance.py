#!/usr/bin/env python3
"""Synthetic Stripe acceptance through an explicit, test-only CLI profile.

Install the official @stripe/cli outside the checkout, then create a temporary
sandbox with `stripe --config /tmp/private-config.toml sandbox create`.
Run this script with --cli, --config, and --project. It prepares hosted
checkout fixtures and separately checks API success, decline, and refund.
Complete the hosted checkout in a browser with Stripe's documented test cards,
then use --verify STATE_FILE to inspect the resulting provider state.
Add --require-hosted to fail unless both hosted success and decline were proved.

This does not exercise a Wabi Stripe adapter or verify Wabi manual receipts.
No real card details, live keys, seller identity, or real funds are required.
"""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import string
import subprocess
import sys
import tempfile
import uuid


class AcceptanceError(Exception):
    pass


def private_json(path, value):
    with open(path, "w", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")


class Sandbox:
    def __init__(self, args, artifacts):
        self.args = args
        self.artifacts = artifacts
        self.sequence = 0
        self.environment = dict(os.environ)
        # The CLI prioritizes ambient STRIPE_API_KEY over its selected profile.
        self.environment.pop("STRIPE_API_KEY", None)
        self.environment["NO_COLOR"] = "1"

    def call(self, command, params=None, allow_error=False):
        self.sequence += 1
        argv = [self.args.cli, "--config", self.args.config,
                "--project-name", self.args.project, "--color", "off", *command]
        if command[0] == "post":
            argv += ["--confirm", "--idempotency", str(uuid.uuid4())]
        for key, value in (params or {}).items():
            argv += ["-d", f"{key}={value}"]
        try:
            result = subprocess.run(argv, env=self.environment, stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=50)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AcceptanceError(f"CLI request {self.sequence} failed ({type(error).__name__}); no output disclosed") from None
        log = self.artifacts / f"request-{self.sequence:02d}.private.json"
        private_json(log, {"exit_code": result.returncode, "stdout": result.stdout,
                           "stderr": result.stderr})
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise AcceptanceError(f"CLI request {self.sequence} returned non-JSON; inspect private artifact") from None
        if not isinstance(payload, dict):
            raise AcceptanceError(f"CLI request {self.sequence} returned an unexpected JSON shape; inspect private artifact")
        if (result.returncode or payload.get("error")) and not allow_error:
            raise AcceptanceError(f"CLI request {self.sequence} failed; inspect private artifact")
        if "livemode" in payload and payload["livemode"] is not False:
            raise AcceptanceError("Live object refused")
        return payload

    def require_test(self, value):
        if value.get("livemode") is not False:
            raise AcceptanceError("Provider response did not establish test mode")
        return value

    def authenticate(self):
        identity = self.call(["whoami", "--format", "json"])
        test_key = identity.get("test_mode_key")
        live_key = identity.get("live_mode_key")
        if identity.get("authenticated") is not True or not isinstance(test_key, dict) or test_key.get("available") is not True:
            raise AcceptanceError("Explicit profile has no authenticated test credential")
        if not isinstance(live_key, dict) or live_key.get("available") is not False:
            raise AcceptanceError("A profile with live credentials is refused; select a test-only sandbox profile")
        if not isinstance(identity.get("account_id"), str) or not re.fullmatch(r"acct_[A-Za-z0-9]+", identity["account_id"]):
            raise AcceptanceError("Authenticated profile did not establish an account")
        return identity


def prepare(sandbox):
    identity = sandbox.authenticate()
    run_id = f"wabi-synthetic-{uuid.uuid4()}"
    common = {"amount": "100", "currency": "usd",
              "automatic_payment_methods[enabled]": "true",
              "automatic_payment_methods[allow_redirects]": "never",
              "metadata[acceptance_run]": run_id}
    success = sandbox.require_test(sandbox.call(["post", "/v1/payment_intents"], {
        **common, "payment_method": "pm_card_visa", "confirm": "true"}))
    if success.get("status") != "succeeded" or success.get("amount_received") != 100 or success.get("currency") != "usd":
        raise AcceptanceError("Synthetic API payment did not succeed for the expected amount")
    decline = sandbox.call(["post", "/v1/payment_intents"], {
        **common, "payment_method": "pm_card_visa_chargeDeclined", "confirm": "true"}, allow_error=True)
    error = decline.get("error", {})
    declined_intent = error.get("payment_intent", {})
    sandbox.require_test(declined_intent)
    if error.get("code") != "card_declined" or error.get("decline_code") != "generic_decline" or declined_intent.get("status") != "requires_payment_method":
        raise AcceptanceError("Synthetic decline did not produce the documented failure state")
    # Refund objects have no livemode field. Bind the refund to the already
    # verified test PaymentIntent, then inspect its test Charge independently.
    refund = sandbox.call(["post", "/v1/refunds"], {
        "payment_intent": success["id"], "amount": "100", "metadata[acceptance_run]": run_id})
    if refund.get("payment_intent") != success["id"] or refund.get("status") != "succeeded" or refund.get("amount") != 100 or refund.get("currency") != "usd":
        raise AcceptanceError("Synthetic refund did not succeed for the expected amount")
    refunded_charge = sandbox.require_test(sandbox.call(["get", f"/v1/charges/{success['latest_charge']}"]))
    if not refunded_charge.get("refunded") or refunded_charge.get("amount_refunded") != 100:
        raise AcceptanceError("Test Charge did not confirm the full synthetic refund")
    price = sandbox.require_test(sandbox.call(["post", "/v1/prices"], {
        "currency": "usd", "unit_amount": "100",
        "product_data[name]": "Wabi synthetic seller item (test only)",
        "metadata[acceptance_run]": run_id}))
    link = sandbox.require_test(sandbox.call(["post", "/v1/payment_links"], {
        "line_items[0][price]": price["id"], "line_items[0][quantity]": "1",
        "metadata[acceptance_run]": run_id,
        "after_completion[type]": "hosted_confirmation",
        "after_completion[hosted_confirmation][custom_message]": "Synthetic sandbox payment; no real funds moved."}))
    if not link.get("url", "").startswith("https://buy.stripe.com/test_"):
        raise AcceptanceError("Hosted link did not establish a test URL")
    sessions = {}
    for case in ("success", "decline"):
        suffix = "".join(secrets.choice(string.ascii_lowercase) for _ in range(8))
        session = sandbox.require_test(sandbox.call(["post", "/v1/checkout/sessions"], {
            "mode": "payment", "line_items[0][price]": price["id"], "line_items[0][quantity]": "1",
            "customer_email": f"wabi-{case}+location_US@example.com",
            "success_url": "https://example.com/wabi-synthetic-success?session_id={CHECKOUT_SESSION_ID}",
            "cancel_url": "https://example.com/wabi-synthetic-cancel",
            "integration_identifier": f"wabi-sandbox-{suffix}",
            "metadata[acceptance_run]": run_id, "metadata[acceptance_case]": case}))
        if session.get("amount_total") != 100 or session.get("currency") != "usd" or not session.get("id", "").startswith("cs_test_"):
            raise AcceptanceError("Hosted checkout amount or environment mismatch")
        sessions[case] = {"id": session["id"], "url": session["url"]}
    state = {"run_id": run_id, "account_id": identity["account_id"],
             "payment_link_id": link["id"], "payment_link_url": link["url"],
             "sessions": sessions}
    state_path = sandbox.artifacts / "state.private.json"
    private_json(state_path, state)
    return {"environment": "test", "scope": "provider fixtures, not Wabi integration",
            "api_payment": "succeeded", "api_decline": "generic_decline/requires_payment_method",
            "api_refund": "succeeded", "hosted_link": "created, not yet paid",
            "hosted_checkout": "created, browser acceptance pending",
            "state_file": str(state_path)}


def verify(sandbox, state_path, require_hosted=False):
    identity = sandbox.authenticate()
    try:
        state = json.loads(Path(state_path).read_text())
    except (OSError, json.JSONDecodeError):
        raise AcceptanceError("Hosted fixture state could not be read; no contents disclosed") from None
    if not isinstance(state, dict) or not isinstance(state.get("sessions"), dict) or set(state["sessions"]) != {"success", "decline"}:
        raise AcceptanceError("Hosted fixture state has an unexpected shape")
    if identity["account_id"] != state.get("account_id"):
        raise AcceptanceError("Fixture account differs from the selected profile")
    if not isinstance(state.get("run_id"), str) or not state["run_id"]:
        raise AcceptanceError("Hosted fixture did not establish a run identifier")
    results = {}
    for case, saved in state["sessions"].items():
        if not isinstance(saved, dict) or not isinstance(saved.get("id"), str) or not re.fullmatch(r"cs_test_[A-Za-z0-9]+", saved["id"]):
            raise AcceptanceError("Hosted fixture did not establish a test Checkout Session")
        session = sandbox.require_test(sandbox.call(["get", f"/v1/checkout/sessions/{saved['id']}"]))
        if session.get("metadata", {}).get("acceptance_run") != state.get("run_id") or session.get("metadata", {}).get("acceptance_case") != case or session.get("amount_total") != 100 or session.get("currency") != "usd":
            raise AcceptanceError("Hosted checkout fixture binding or amount changed")
        results[case] = {"status": session.get("status"), "payment_status": session.get("payment_status")}
        if session.get("payment_intent"):
            intent = sandbox.require_test(sandbox.call(["get", f"/v1/payment_intents/{session['payment_intent']}"]))
            if intent.get("amount") != 100 or intent.get("currency") != "usd":
                raise AcceptanceError("Hosted payment amount or currency changed")
            results[case]["payment_intent_status"] = intent["status"]
            failure = intent.get("last_payment_error") or {}
            if failure:
                results[case]["error_code"] = failure.get("code")
                results[case]["decline_code"] = failure.get("decline_code")
    success = results["success"]
    decline = results["decline"]
    passed = (success.get("status") == "complete" and success.get("payment_status") == "paid"
              and success.get("payment_intent_status") == "succeeded"
              and decline.get("status") == "open" and decline.get("payment_status") == "unpaid"
              and decline.get("payment_intent_status") == "requires_payment_method"
              and decline.get("error_code") == "card_declined" and decline.get("decline_code") == "generic_decline")
    if require_hosted and not passed:
        raise AcceptanceError("Hosted success and decline acceptance is incomplete; inspect private artifact")
    return {"environment": "test", "scope": "provider fixtures, not Wabi integration",
            "hosted_checkout": results, "hosted_checkout_acceptance": "passed" if passed else "pending"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, help="Path to official Stripe CLI")
    parser.add_argument("--config", required=True, help="Private temporary CLI configuration")
    parser.add_argument("--project", required=True, help="Explicit test-only CLI profile")
    parser.add_argument("--verify", metavar="STATE_FILE", help="Inspect earlier hosted checkout fixtures")
    parser.add_argument("--require-hosted", action="store_true", help="Require --verify to prove hosted success and decline")
    args = parser.parse_args()
    if args.require_hosted and not args.verify:
        parser.error("--require-hosted requires --verify")
    os.umask(0o077)
    artifacts = Path(tempfile.mkdtemp(prefix="wabi-stripe-acceptance-", dir="/tmp"))
    os.chmod(artifacts, 0o700)
    sandbox = Sandbox(args, artifacts)
    try:
        summary = verify(sandbox, args.verify, args.require_hosted) if args.verify else prepare(sandbox)
        summary["private_artifacts"] = str(artifacts)
        private_json(artifacts / "summary.json", summary)
        print(json.dumps(summary, indent=2))
    except AcceptanceError as error:
        print(json.dumps({"error": str(error), "private_artifacts": str(artifacts)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
