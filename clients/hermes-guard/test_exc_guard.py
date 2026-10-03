"""exc-guard: cache-ből dönt, hibánál exit 2 (a Hermes fail_closed ettől blokkol)."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "excellence-guard"))
import policy
import runtime

ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(ROOT, "exc-guard")


def run(home, payload):
    env = {**os.environ, "HERMES_HOME": home}
    return subprocess.run([sys.executable, SCRIPT], input=json.dumps(payload), text=True, capture_output=True, env=env)


def write_cache(home, snapshot, cached_at=None, revoked=False):
    runtime.write_json(
        runtime._under(home, runtime.CACHE_FILE),
        {"cachedAt": time.time() if cached_at is None else cached_at, "revoked": revoked, "snapshot": snapshot},
    )


class ExcGuard(unittest.TestCase):
    def test_allow_block_and_missing_cache(self):
        home = tempfile.mkdtemp()
        missing = run(home, {"tool_name": "terminal", "tool_input": {"command": "ls"}})
        self.assertEqual(missing.returncode, 0)
        self.assertEqual(json.loads(missing.stdout)["action"], "block")

        write_cache(home, policy.snapshot_of(policy.FREE))
        allowed = run(home, {"hook_event_name": "pre_tool_call", "tool_name": "terminal", "tool_input": {"command": "ls"}})
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

    def test_expired_cache_is_bound_and_garbage_exits_2(self):
        home = tempfile.mkdtemp()
        write_cache(home, policy.snapshot_of(policy.FREE), cached_at=time.time() - 3601)
        expired = run(home, {"tool_name": "terminal", "tool_input": {}})
        self.assertEqual(json.loads(expired.stdout)["action"], "block")

        env = {**os.environ, "HERMES_HOME": home}
        broken = subprocess.run([sys.executable, SCRIPT], input="nem json", text=True, capture_output=True, env=env)
        self.assertEqual(broken.returncode, 2)
        self.assertIn("nem engedem", broken.stderr)


if __name__ == "__main__":
    unittest.main()
