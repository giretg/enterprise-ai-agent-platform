"""D4 cache, audit-sor, managed-dir hash. Futtatás: python3 clients/hermes-guard/test_guard_runtime.py"""
import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "excellence-guard"))
import policy
import runtime


class Runtime(unittest.TestCase):
    def test_managed_dir_hash_matches_v1_8_vector(self):
        files = {"config.yaml": b"a\n", ".env": b"b\n", "excellence-install-id": b"id\n"}
        self.assertEqual(runtime.managed_dir_hash(files), "0589eb3acdd43a350f50e45951471fcb70ff45fef63b8ef1ee11db4c1dd73074")
        empty = {name: b"" for name in runtime.MANAGED_FILES}
        self.assertEqual(runtime.managed_dir_hash(empty), "c284b08767c6d8ef2b01f8f48325b6234f07ef1c335a136a966ebb6eaa147d49")

    def test_d4_refresh_revocation_and_session_change(self):
        home = tempfile.mkdtemp()
        clock = [1_000]
        box = {"status": "ok", "snap": policy.snapshot_of(policy.FREE, version="free-1")}

        def fetcher():
            return box["status"], box["snap"]

        client = runtime.SnapshotClient(home, fetcher=fetcher, now=lambda: clock[0], revalidate=15, offline_ttl=3600)
        guard = runtime.Guard(home, client=client, now=lambda: clock[0])
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        try:
            self.assertIsNone(guard.pre_tool_call("terminal", {"command": "ls"}, session_id="s1", tool_call_id="c1"))
            clock[0] = 1_010  # D4: down mellett a friss snapshot 1 óráig marad
            box["status"] = "down"
            self.assertIsNone(guard.pre_tool_call("terminal", {}, session_id="s1"))
            clock[0] = 1_000 + 3601
            blocked = guard.pre_tool_call("terminal", {}, session_id="s1")
            self.assertEqual(blocked["action"], "block")
            self.assertIn("nem elérhető", blocked["message"])

            clock[0] += 1
            box["status"] = "ok"
            box["snap"] = policy.snapshot_of(policy.FREE, version="free-2")
            self.assertIsNone(guard.pre_tool_call("terminal", {}, session_id="s1"))

            clock[0] += 5  # P4: visszavonás a következő hívásnál, a 15 s-os revalidate ablakon belül is
            box["status"] = "revoked"
            revoked = guard.pre_tool_call("read_file", {}, session_id="s1")
            self.assertIn("nincs hozzáférésed", revoked["message"])
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)

    def test_audit_queue_depth_retry_and_origin(self):
        home = tempfile.mkdtemp()
        clock = [5_000]
        box = {"snap": policy.snapshot_of(policy.FREE, version="p")}  # prompt_and_response

        client = runtime.SnapshotClient(home, fetcher=lambda: ("ok", box["snap"]), now=lambda: clock[0])
        guard = runtime.Guard(home, client=client, now=lambda: clock[0])
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        try:
            guard.pre_llm_call(session_id="s", turn_id="t", user_message="szia")
            guard.pre_tool_call("mcp__excellence__kb_search", {}, session_id="s", turn_id="t", tool_call_id="call-1")
            guard.post_tool_call("mcp__excellence__kb_search", {"q": "x"}, "találat", session_id="s", turn_id="t", tool_call_id="call-1", status="ok")
            guard.post_llm_call(session_id="s", turn_id="t", assistant_response="kész")
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)

        queued_path = runtime._under(home, runtime.QUEUE_FILE)
        self.assertEqual(stat.S_IMODE(os.stat(queued_path).st_mode), 0o600)
        queued = runtime._read_queue(queued_path)
        kinds = [event["kind"] for event in queued]
        self.assertEqual(kinds, ["user_prompt", "tool_call", "final"])
        self.assertEqual(queued[0]["content"], "szia")
        self.assertNotIn("content", queued[1])  # prompt_and_response: a tool-eredmény kimarad
        self.assertEqual(queued[1]["meta"]["origin"], "mcp")
        self.assertEqual(queued[1]["meta"]["decision"], "allow")
        self.assertEqual(queued[2]["content"], "kész")

        self.assertEqual(runtime.flush_queue(home, lambda events: "retry"), 0)
        self.assertEqual(len(runtime._read_queue(runtime._under(home, runtime.QUEUE_FILE))), 3)
        seen = {}

        def post(events):
            seen["n"] = len(events)
            return "ok"

        self.assertEqual(runtime.flush_queue(home, post), 3)
        self.assertEqual(seen["n"], 3)
        self.assertEqual(runtime._read_queue(runtime._under(home, runtime.QUEUE_FILE)), [])

        deep = policy.snapshot_of(policy.BOUND)  # plus_tool_results
        event = runtime.build_event(deep, "s", None, "tool_call", {"args": {"a": 1}, "result": "r"}, {"tool": "terminal"})
        self.assertEqual(event["content"]["result"], "r")
        meta_only = runtime.build_event(policy.snapshot_of({**policy.FREE, "audit_depth": "metadata"}), "s", None, "user_prompt", "titok", {})
        self.assertNotIn("content", meta_only)

    def test_llm_execution_blocks_foreign_provider(self):
        home = tempfile.mkdtemp()
        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("down", None)))
        called = []
        blocked = guard.llm_execution(request={"model": "x"}, next_call=lambda req: called.append(req) or "live", provider="openrouter", base_url="https://openrouter.ai/api")
        self.assertEqual(called, [])
        self.assertIn("Excellence", blocked.choices[0].message.content)
        self.assertEqual(blocked.choices[0].finish_reason, "stop")
        live = guard.llm_execution(request={"model": "m"}, next_call=lambda req: "ok", provider="excellence", base_url="https://ai.example/api/model-gateway/v1")
        self.assertEqual(live, "ok")

    def test_heartbeat_payload_shape(self):
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "config.yaml"), "w") as fh:
            fh.write("model:\n  provider: excellence\n")
        sent = {}

        def fake_post(url, token, payload, timeout=5):
            sent["url"] = url
            sent["payload"] = payload
            return 200, {"intervalSeconds": 30, "freshnessSeconds": 90}

        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("ok", policy.snapshot_of(policy.FREE, version="v9"))))
        guard.note_session("sess-1")
        guard._version = "0.21.5"
        guard._origin_and_token = lambda: ("https://ai.example", "jwt")
        original_post = runtime.post_json
        runtime.post_json = fake_post
        try:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
            guard.beat()
        finally:
            runtime.post_json = original_post
        body = sent["payload"]
        self.assertTrue(sent["url"].endswith("/api/client-policy/heartbeat"))
        self.assertEqual(body["policyVersion"], "v9")
        self.assertEqual(body["guardVersion"], "0.1.0")
        self.assertEqual(body["hermesVersion"], "0.21.5")
        self.assertEqual(body["sessions"], ["sess-1"])
        self.assertEqual(len(body["configHash"]), 64)
        self.assertEqual(len(body["managedDirHash"]), 64)
        self.assertEqual(guard.interval, 30)
        json.dumps(body)


if __name__ == "__main__":
    unittest.main()
