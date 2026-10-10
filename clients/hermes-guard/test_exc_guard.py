"""exc-guard: friss szerver-policy dönt; a user írható cache nem ad engedélyt."""
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "excellence-guard"))
import policy
import runtime

ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(ROOT, "exc-guard")


spec = importlib.util.spec_from_file_location("exc_guard", SCRIPT, loader=SourceFileLoader("exc_guard", SCRIPT))
guard_script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard_script)


def run(home, payload, status="down", snapshot=None, origin="https://ai.example"):
    output = io.StringIO()
    helper = SimpleNamespace(read_profile=lambda _home: (origin, "tenant", "agent"))
    with patch.dict(os.environ, {"HERMES_HOME": home}), patch("sys.stdin", io.StringIO(json.dumps(payload))), patch("sys.stdout", output), patch.object(guard_script, "managed_gateway_url", return_value="https://ai.example/api/model-gateway/v1"), patch.object(runtime, "load_exc_token", return_value=helper), patch.object(runtime, "fetch_snapshot", return_value=(status, snapshot)) as fetcher:
        code = guard_script.main()
    return SimpleNamespace(returncode=code, stdout=output.getvalue(), fetch_calls=fetcher.call_count)


def write_cache(home, snapshot, cached_at=None, revoked=False):
    runtime.write_json(
        runtime._under(home, runtime.CACHE_FILE),
        {"cachedAt": time.time() if cached_at is None else cached_at, "revoked": revoked, "snapshot": snapshot},
    )


class ExcGuard(unittest.TestCase):
    def test_server_policy_wins_over_forged_cache(self):
        home = tempfile.mkdtemp()
        missing = run(home, {"tool_name": "terminal", "tool_input": {"command": "ls"}})
        self.assertEqual(missing.returncode, 0)
        self.assertEqual(json.loads(missing.stdout)["action"], "block")

        write_cache(home, policy.snapshot_of(policy.FREE))
        blocked = run(home, {"tool_name": "terminal", "tool_input": {}}, status="ok", snapshot=policy.snapshot_of(policy.BOUND))
        self.assertEqual(json.loads(blocked.stdout)["action"], "block")
        self.assertEqual(blocked.fetch_calls, 1)
        down = run(home, {"tool_name": "terminal", "tool_input": {}})
        self.assertEqual(json.loads(down.stdout)["action"], "block")
        allowed = run(home, {"hook_event_name": "pre_tool_call", "tool_name": "terminal", "tool_input": {"command": "ls"}}, status="ok", snapshot=policy.snapshot_of(policy.FREE))
        self.assertEqual(allowed.returncode, 0)
        self.assertEqual(json.loads(allowed.stdout), {})

        write_cache(home, policy.snapshot_of(policy.BOUND))
        blocked = run(home, {"tool_name": "terminal", "tool_input": {"command": "ls"}})
        body = json.loads(blocked.stdout)
        self.assertEqual(body["action"], "block")
        self.assertIn("nem futtathatsz", body["message"])

        unknown = run(home, {"tool_name": "mcp__github__search", "tool_input": {}})
        self.assertEqual(json.loads(unknown.stdout)["action"], "block")
        self.assertIn("github", json.loads(unknown.stdout)["message"])

    def test_foreign_profile_cannot_supply_permissive_policy(self):
        with tempfile.TemporaryDirectory() as home:
            result = run(home, {"tool_name": "terminal"}, status="ok", snapshot=policy.snapshot_of(policy.FREE), origin="https://foreign.example")
            self.assertEqual(json.loads(result.stdout)["action"], "block")
            self.assertEqual(result.fetch_calls, 0)

    def test_revoked_server_blocks_company_tools(self):
        with tempfile.TemporaryDirectory() as home:
            result = run(home, {"tool_name": "mcp__excellence__search"}, status="revoked")
            self.assertEqual(json.loads(result.stdout)["action"], "block")
            self.assertIn("nincs hozzáférésed", json.loads(result.stdout)["message"])

    def test_expired_cache_is_bound_and_garbage_exits_2(self):
        home = tempfile.mkdtemp()
        write_cache(home, policy.snapshot_of(policy.FREE), cached_at=time.time() - 3601)
        expired = run(home, {"tool_name": "terminal", "tool_input": {}})
        self.assertEqual(json.loads(expired.stdout)["action"], "block")

        env = {**os.environ, "HERMES_HOME": home}
        broken = subprocess.run([sys.executable, SCRIPT], input="nem json", text=True, capture_output=True, env=env)
        self.assertEqual(broken.returncode, 2)
        self.assertIn("nem engedem", broken.stderr)

    def test_user_owned_managed_config_is_rejected(self):
        with tempfile.TemporaryDirectory() as managed:
            with open(os.path.join(managed, "config.yaml"), "w") as fh:
                fh.write('model:\n  base_url: "https://ai.example/api/model-gateway/v1"\n')
            self.assertTrue(guard_script.user_can_change(os.path.join(managed, "config.yaml")))
            with self.assertRaises(ValueError):
                guard_script.managed_gateway_url(managed)


if __name__ == "__main__":
    unittest.main()
