"""D4 cache, audit-sor, managed-dir hash. Futtatás: python3 clients/hermes-guard/test_guard_runtime.py"""
import json
import os
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "excellence-guard"))
import policy
import runtime


class Runtime(unittest.TestCase):
    def test_user_environment_cannot_replace_installed_token_helper(self):
        with tempfile.TemporaryDirectory() as home:
            fake = os.path.join(home, "fake.py")
            with open(fake, "w") as fh:
                fh.write("def get_token(_home): return 'forged'\n")
            with patch.dict(os.environ, {"EXC_TOKEN_BIN": fake}), patch.object(runtime, "__file__", os.path.join(home, "plugins", "runtime.py")), patch.object(runtime, "TOKEN_HELPER_PATH", os.path.join(home, "missing")):
                self.assertIsNone(runtime.load_exc_token())

    def test_windows_user_redirect_is_refused_and_posix_override_stays(self):
        company = r"C:\ProgramData\Excellence\hermes"
        self.assertEqual(runtime._paths.resolve_managed_dir(None, True), company)
        self.assertEqual(runtime._paths.resolve_managed_dir(company, True), company)
        self.assertEqual(runtime._paths.resolve_managed_dir(company + "\\", True), company)
        with self.assertRaises(runtime.ManagedDirRedirected):
            runtime._paths.resolve_managed_dir(r"C:\Users\evil\hermes", True)
        self.assertEqual(runtime._paths.resolve_managed_dir("/tmp/floor", False), "/tmp/floor")
        with patch.object(runtime, "managed_dir", side_effect=runtime.ManagedDirRedirected("x")):
            self.assertEqual(runtime.reported_managed_dir_hash(), "redirected")

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

    def test_unclassified_tool_is_reported_without_arguments(self):
        home = tempfile.mkdtemp()
        snap = policy.snapshot_of(policy.BOUND, version="p")
        client = runtime.SnapshotClient(home, fetcher=lambda: ("ok", snap), now=lambda: 5_000)
        guard = runtime.Guard(home, client=client, now=lambda: 5_000)
        guard._version = "hermes v0.21.3"
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        try:
            body = guard.pre_tool_call("ha_call_service", {"secret": "titok"}, session_id="s", tool_call_id="c1")
            guard.pre_tool_call("clarify", {}, session_id="s", tool_call_id="c2")
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
        self.assertEqual(body["action"], "block")
        queued = runtime._read_queue(runtime._under(home, runtime.QUEUE_FILE))
        self.assertEqual([e["kind"] for e in queued], ["tool_unclassified"])
        self.assertEqual(queued[0]["meta"], {"tool": "ha_call_service", "hermesVersion": "hermes v0.21.3"})
        self.assertNotIn("content", queued[0])
        self.assertNotIn("titok", json.dumps(queued[0]))

    def test_llm_execution_blocks_foreign_provider(self):
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "config.yaml"), "w") as fh:
            fh.write("mcp_servers:\n  excellence:\n    url: https://ai.example/api/mcp/tenant\n    headers:\n      X-Excellence-Agent-Id: agent-1\n")
        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("down", None)))
        guard._gateway_token = lambda: ("jwt", None)
        called = []
        blocked = guard.llm_execution(request={"model": "x"}, next_call=lambda req: called.append(req) or "live", provider="openrouter", base_url="https://openrouter.ai/api")
        self.assertEqual(called, [])
        self.assertIn("Excellence", blocked.choices[0].message.content)
        self.assertEqual(blocked.choices[0].finish_reason, "stop")
        live = guard.llm_execution(request={"model": "m"}, next_call=lambda req: "ok", provider="custom", base_url="https://ai.example/api/model-gateway/v1")
        self.assertEqual(live, "ok")
        request = {"extra_headers": {"Custom": "retained", "x-excellence-turn": "stale"}}
        forwarded = guard.llm_execution(request=request, next_call=lambda req: req, provider="custom", base_url="https://ai.example/api/model-gateway/v1", session_id="session-1", turn_id="turn-1")
        self.assertEqual(forwarded["extra_headers"], {"Custom": "retained", "X-Excellence-Session": "session-1", "X-Excellence-Turn": "turn-1", "Authorization": "Bearer jwt"})
        self.assertEqual(request["extra_headers"]["x-excellence-turn"], "stale")
        foreign = guard.llm_execution(request={}, next_call=lambda req: called.append(req), provider="custom", base_url="https://foreign.example/api/model-gateway/v1")
        self.assertEqual(called, [])
        self.assertIn("Excellence", foreign.choices[0].message.content)

        def provider_failure(_request):
            raise ValueError("context length exceeded")

        with self.assertRaisesRegex(ValueError, "context length exceeded"):
            guard.llm_execution(request={}, next_call=provider_failure, provider="custom", base_url="https://ai.example/api/model-gateway/v1")

    def test_llm_execution_without_company_profile_fails_closed(self):
        with tempfile.TemporaryDirectory() as home:
            guard = runtime.Guard(home)
            called = []
            response = guard.llm_execution(request={}, next_call=lambda req: called.append(req), provider="custom", base_url="https://ai.example/api/model-gateway/v1")
            self.assertEqual(called, [])
            self.assertIn("Excellence", response.choices[0].message.content)
            # Hiányzó asszisztens: a valódi okot mondja, nem a modellváltós üzenetet (#858).
            self.assertNotEqual(response.choices[0].message.content, policy.PROVIDER_BLOCK)
            self.assertIn("Hermes-profilnak", response.choices[0].message.content)

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
        self.assertEqual(body["guardVersion"], "0.3.0")
        self.assertEqual(body["hermesVersion"], "0.21.5")
        self.assertEqual(body["sessions"], ["sess-1"])
        self.assertEqual(len(body["configHash"]), 64)
        self.assertEqual(len(body["managedDirHash"]), 64)
        self.assertEqual(guard.interval, 30)
        json.dumps(body)

    def test_first_llm_call_registers_session_before_forwarding(self):
        # Új session első hívása: a szerver kapuja csak bejelentett session-t enged (#858).
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "config.yaml"), "w") as fh:
            fh.write("mcp_servers:\n  excellence:\n    url: https://ai.example/api/mcp/tenant\n")
        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("down", None)))
        guard._origin_and_token = lambda: ("https://ai.example", "jwt")
        guard._gateway_token = lambda: ("jwt", None)
        order, original_post = [], runtime.post_json
        runtime.post_json = lambda url, token, payload, timeout=5: (order.append(("beat", payload["sessions"])) or 200, {})
        try:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
            call = lambda: guard.llm_execution(request={}, next_call=lambda req: order.append("call") or "ok", provider="custom", base_url="https://ai.example/api/model-gateway/v1", session_id="s-new")
            self.assertEqual(call(), "ok")
            self.assertEqual(call(), "ok")
        finally:
            runtime.post_json = original_post
        # Minden hívás előtt heartbeat: a kapu 180s után Open, ha a háttérszál kimarad.
        self.assertEqual(order, [("beat", ["s-new"]), "call", ("beat", ["s-new"]), "call"])

    def test_llm_execution_puts_fresh_gateway_token_on_the_request(self):
        # A Hermes a JWT-t kliens-initkor cache-eli; 10 perc után 401. A Guard minden hívásra friss tokent tesz.
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "config.yaml"), "w") as fh:
            fh.write("mcp_servers:\n  excellence:\n    url: https://ai.example/api/mcp/tenant\n    headers:\n      X-Excellence-Agent-Id: agent-1\n")
        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("down", None)))
        guard._gateway_token = lambda: ("fresh-jwt", None)
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        forwarded = guard.llm_execution(
            request={"extra_headers": {"Authorization": "Bearer stale"}},
            next_call=lambda req: req,
            provider="custom",
            base_url="https://ai.example/api/model-gateway/v1",
            session_id="s-1",
        )
        self.assertEqual(forwarded["extra_headers"]["Authorization"], "Bearer fresh-jwt")
        self.assertEqual(forwarded["extra_headers"]["X-Excellence-Session"], "s-1")

    def test_llm_execution_keeps_token_fresh_for_in_call_stream_retry(self):
        # 10-17 Réka: elakadt stream után a Hermes a next_call-on belül ugyanazt a fejlécet küldte újra → lejárt JWT, 401.
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "config.yaml"), "w") as fh:
            fh.write("mcp_servers:\n  excellence:\n    url: https://ai.example/api/mcp/tenant\n    headers:\n      X-Excellence-Agent-Id: agent-1\n")
        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("down", None)))
        tokens = iter(["jwt-1", "jwt-2", "jwt-3", "jwt-4"])
        guard._gateway_token = lambda: (next(tokens, "jwt-last"), None)
        sent = []

        def provider_with_retry(req):
            sent.append(req["extra_headers"]["Authorization"])
            deadline = time.time() + 2
            while req["extra_headers"]["Authorization"] == sent[0] and time.time() < deadline:
                time.sleep(0.01)
            sent.append(req["extra_headers"]["Authorization"])  # az újrapróbálás ugyanazt a dictet olvassa
            return req

        os.environ["EXC_GUARD_OFFLINE"] = "1"
        with patch.object(runtime, "TOKEN_REFRESH_SECONDS", 0.05):
            try:
                forwarded = guard.llm_execution(request={}, next_call=provider_with_retry, provider="custom", base_url="https://ai.example/api/model-gateway/v1")
            finally:
                os.environ.pop("EXC_GUARD_OFFLINE", None)
        self.assertEqual(sent[0], "Bearer jwt-1")
        self.assertNotEqual(sent[1], sent[0])
        after = forwarded["extra_headers"]["Authorization"]
        time.sleep(0.2)
        self.assertEqual(forwarded["extra_headers"]["Authorization"], after)  # a hívás végén a frissítés leáll

    def test_llm_execution_token_failure_never_forwards_without_jwt(self):
        # #895: első get_token hiba, második siker → régen JWT nélkül ment ki (401 invalid_token).
        class Fail(Exception):
            pass

        calls = []

        def get_token(_home):
            calls.append(1)
            if len(calls) == 1:
                raise Fail("A belépés nem sikerült, próbáld újra.")
            return "late-jwt"

        helper = type("Helper", (), {"Fail": Fail, "get_token": staticmethod(get_token), "read_profile": staticmethod(lambda _h: ("https://ai.example", "agent-1"))})
        guard = runtime.Guard(tempfile.mkdtemp(), client=runtime.SnapshotClient(tempfile.mkdtemp(), fetcher=lambda: ("down", None)))
        forwarded = []
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        try:
            with patch.object(runtime, "load_exc_token", return_value=helper):
                response = guard.llm_execution(request={"extra_headers": {"Authorization": "Bearer oauth"}}, next_call=forwarded.append, provider="custom", base_url="https://ai.example/api/model-gateway/v1")
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
        self.assertEqual(forwarded, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(response.choices[0].message.content, "A belépés nem sikerült, próbáld újra.")

    def test_llm_execution_without_mcp_login_shows_login_error(self):
        # Réka-bot: van agent-id, nincs MCP token → ne „AI service returned an error” legyen.
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "config.yaml"), "w") as fh:
            fh.write("mcp_servers:\n  excellence:\n    url: https://ai.example/api/mcp/tenant\n    headers:\n      X-Excellence-Agent-Id: agent-1\n")
        guard = runtime.Guard(home, client=runtime.SnapshotClient(home, fetcher=lambda: ("down", None)))
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        called = []
        try:
            response = guard.llm_execution(
                request={"model": "m"},
                next_call=lambda req: called.append(req) or "live",
                provider="custom",
                base_url="https://ai.example/api/model-gateway/v1",
            )
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
        self.assertEqual(called, [])
        self.assertIn("Jelentkezz be", response.choices[0].message.content)
        self.assertNotEqual(response.choices[0].message.content, policy.PROVIDER_BLOCK)

    def test_session_start_copies_parent_mcp_tokens_into_bot(self):
        root = tempfile.mkdtemp()
        bot = os.path.join(root, "profiles", "exc-reka")
        os.makedirs(bot)
        with open(os.path.join(bot, "config.yaml"), "w") as fh:
            fh.write("mcp_servers:\n  excellence:\n    url: https://ai.example/api/mcp/tenant\n")
        os.makedirs(os.path.join(root, "mcp-tokens"))
        with open(os.path.join(root, "mcp-tokens", "excellence.json"), "w") as fh:
            json.dump({"access_token": "oauth-parent"}, fh)
        guard = runtime.Guard(bot, client=runtime.SnapshotClient(bot, fetcher=lambda: ("down", None)))
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        try:
            guard.on_session_start(session_id="s1")
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
        copied = os.path.join(bot, "mcp-tokens", "excellence.json")
        self.assertTrue(os.path.isfile(copied))
        self.assertEqual(json.load(open(copied))["access_token"], "oauth-parent")

    def test_write_json_does_not_share_tmp_name_across_threads(self):
        home = tempfile.mkdtemp()
        path = os.path.join(home, "snapshot.json")
        seen = []
        original_open = os.open

        def tracking_open(name, flags, mode=0o777):
            if str(name).startswith(path + "."):
                seen.append(name)
            return original_open(name, flags, mode)

        with patch.object(os, "open", tracking_open):
            runtime.write_json(path, {"a": 1})
            runtime.write_json(path, {"a": 2})
        self.assertEqual(len(seen), 2)
        self.assertEqual(len(set(seen)), 2)
        self.assertEqual(runtime.read_json(path), {"a": 2})


if __name__ == "__main__":
    unittest.main()
