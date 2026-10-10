"""Döntési mátrix: allow / approve / block, ismeretlen MCP, tool-szabály. Futtatás: python3 clients/hermes-guard/test_guard_policy.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "excellence-guard"))
import policy as p


def snap(caps, rules=(), source="user_preset"):
    return p.snapshot_of(caps, rules, source=source)


class Policy(unittest.TestCase):
    def test_company_mode_notice_matches_spec(self):
        self.assertEqual(
            p.NOTICE,
            "Ez a munkatárs céges módban fut, a beszélgetéseid naplózásra kerülnek.",
        )

    def test_free_developer_runs_terminal_bound_billing_does_not(self):
        allow = p.decide(snap(p.FREE), "terminal", {"command": "ls"})
        block = p.decide(snap(p.BOUND, source="agent_ceiling"), "terminal", {"command": "ls"})
        self.assertEqual(allow.action, "allow")
        self.assertEqual(block.action, "block")
        self.assertIn("nem futtathatsz", block.message)
        self.assertIn("nem erre való", block.message)
        self.assertIn("rendszergazdát", block.message)

    def test_levels_for_files_browser_web_skills_delegation(self):
        standard = snap(p.STANDARD)
        self.assertEqual(p.decide(standard, "read_file").action, "allow")
        self.assertEqual(p.decide(standard, "write_file").action, "block")
        self.assertEqual(p.decide(standard, "terminal").action, "block")
        self.assertIn("homokozó", p.decide(standard, "execute_code").message)
        self.assertEqual(p.decide(standard, "browser_navigate").action, "block")
        self.assertEqual(p.decide(standard, "web_search").action, "block")
        self.assertEqual(p.decide(standard, "skill_view").action, "block")
        self.assertEqual(p.decide(standard, "skill_manage").action, "block")
        self.assertEqual(p.decide(standard, "delegate_task").action, "approve")  # audited, de risky
        self.assertEqual(p.decide(snap(p.BOUND), "delegate_task").action, "block")
        self.assertEqual(p.decide(snap(p.BOUND), "cronjob_manage").action, "block")

    def test_local_with_approval_and_human_approval_overlay(self):
        caps = {**p.FREE, "code_execution": "local_with_approval", "human_approval": "none"}
        self.assertEqual(p.decide(snap(caps), "terminal").action, "approve")
        always = snap({**p.FREE, "human_approval": "always"})
        self.assertEqual(p.decide(always, "read_file").action, "approve")
        risky = snap({**p.FREE, "human_approval": "risky"})
        self.assertEqual(p.decide(risky, "terminal").action, "approve")
        self.assertEqual(p.decide(risky, "read_file").action, "allow")

    def test_unclassified_tool_is_denied_unless_explicit_rule(self):
        bound = p.decide(snap(p.BOUND), "image_generate")
        self.assertEqual(bound.action, "block")
        self.assertIn("nincs engedve", bound.message)
        free = p.decide(snap(p.FREE), "ha_call_service")
        self.assertEqual(free.action, "block")
        allowed = snap(p.FREE, ({"pattern": "image_generate", "action": "allow", "source": "user"},))
        self.assertEqual(p.decide(allowed, "image_generate").action, "allow")

    def test_explicit_tool_rule_beats_capability_and_deny_wins(self):
        rules = (
            {"pattern": "terminal", "action": "allow", "source": "user"},
            {"pattern": "mcp__crm__*", "action": "allow", "source": "user"},
            {"pattern": "mcp__crm__delete", "action": "deny", "source": "agent"},
        )
        denied_code = snap({**p.BOUND, "human_approval": "none"}, rules)
        self.assertEqual(p.decide(denied_code, "terminal").action, "allow")
        self.assertEqual(p.decide(denied_code, "mcp__crm__read").action, "allow")
        blocked = p.decide(denied_code, "mcp__crm__delete")
        self.assertEqual(blocked.action, "block")
        self.assertIn("tiltja", blocked.message)

    def test_tool_allow_cannot_exceed_agent_ceiling(self):
        rules = ({"pattern": "*", "action": "allow", "source": "user"},)
        limited = snap(p.FREE, rules)
        limited["agentCeilings"] = {"code_execution": "denied", "mcp_servers": "company_only", "human_approval": "always"}
        self.assertEqual(p.decide(limited, "terminal").action, "block")
        self.assertEqual(p.decide(limited, "mcp__github__search").action, "block")
        self.assertEqual(p.decide(limited, "read_file").action, "approve")
        approved = snap(p.FREE, ({"pattern": "mcp__github__*", "action": "allow", "source": "user"},))
        approved["agentCeilings"] = {"mcp_servers": "plus_approved"}
        self.assertEqual(p.decide(approved, "mcp__github__search").action, "allow")

    def test_old_cached_snapshot_cannot_authorize_tool_exception(self):
        old = snap(p.BOUND, ({"pattern": "terminal", "action": "allow", "source": "user"},))
        del old["agentCeilings"]
        cached = p.interpret_cache({"cachedAt": 1000, "snapshot": old}, 1010)
        self.assertEqual(p.decide_interpreted(cached, "terminal").action, "block")

    def test_unknown_mcp_server_is_blocked_company_server_is_not(self):
        bound = snap(p.BOUND)
        unknown = p.decide(bound, "mcp__github__search")
        self.assertEqual(unknown.action, "block")
        self.assertIn("github", unknown.message)
        self.assertIn("rendszergazdát", unknown.message)
        # Kötött pálya + risky: a céges MCP jóváhagyással megy, nem szabadon.
        self.assertEqual(p.decide(bound, "mcp__excellence__kb_search").action, "approve")
        free = snap(p.FREE)  # plus_approved, human_approval none
        self.assertEqual(p.decide(free, "mcp__excellence__kb_search").action, "allow")
        self.assertEqual(p.decide(free, "mcp__github__search").action, "block")
        opened = snap({**p.FREE, "mcp_servers": "free"})
        self.assertEqual(p.decide(opened, "mcp__github__search").action, "allow")

    def test_company_server_env_and_malformed_mcp_name(self):
        os.environ["EXCELLENCE_MCP_SERVER"] = "billing"
        os.environ["EXCELLENCE_COMPANY_MCP_SERVERS"] = "github,billing"
        try:
            self.assertEqual(p.decide(snap(p.BOUND), "mcp__billing__invoice").action, "block")
            self.assertEqual(p.decide(snap(p.BOUND), "mcp__github__search").action, "block")
            self.assertEqual(p.decide(snap(p.BOUND), "mcp__excellence__invoice").action, "approve")
        finally:
            os.environ.pop("EXCELLENCE_MCP_SERVER", None)
            os.environ.pop("EXCELLENCE_COMPANY_MCP_SERVERS", None)
        self.assertEqual(p.decide(snap({**p.FREE, "mcp_servers": "company_only", "human_approval": "none"}), "mcp__no_separator").action, "block")

    def test_offline_bound_and_revoked(self):
        offline = p.decide_interpreted({"kind": "bound"}, "terminal")
        self.assertEqual(offline.action, "block")
        self.assertIn("nem elérhető", offline.message)
        revoked = p.decide_interpreted({"kind": "revoked"}, "read_file")
        self.assertEqual(revoked.action, "block")
        self.assertIn("nincs hozzáférésed", revoked.message)

    def test_cache_ttl(self):
        fresh = {"cachedAt": 1000, "revoked": False, "snapshot": snap(p.FREE)}
        self.assertEqual(p.interpret_cache(fresh, 1000 + 3599)["kind"], "snapshot")
        self.assertEqual(p.interpret_cache(fresh, 1000 + 3600)["kind"], "bound")
        self.assertEqual(p.interpret_cache({"cachedAt": 1000, "revoked": True, "snapshot": snap(p.FREE)}, 1001)["kind"], "revoked")
        self.assertEqual(p.interpret_cache(None, 1)["kind"], "bound")

    def test_audit_depth_and_excellence_route(self):
        self.assertIsNone(p.keep_content("metadata", "user_prompt", "titok"))
        self.assertEqual(p.keep_content("prompt_and_response", "final", "válasz"), "válasz")
        self.assertIsNone(p.keep_content("prompt_and_response", "tool_call", {"args": 1}))
        self.assertEqual(p.keep_content("plus_tool_results", "tool_call", {"args": 1}), {"args": 1})
        gateway = "https://ai.example/api/model-gateway/v1"
        for provider in ("excellence", "custom"):
            self.assertTrue(p.is_excellence_route(provider, gateway, gateway))
            self.assertTrue(p.is_excellence_route(provider, "https://ai.example:443/api/model-gateway/v1/", gateway))
            for url in ("", "https://evil.example/api/model-gateway/v1", gateway + "/other", gateway + "?proxy=evil", gateway + "#fragment", "https://user@ai.example/api/model-gateway/v1", "http://ai.example/api/model-gateway/v1", "https://ai.example:bad/api/model-gateway/v1"):
                self.assertFalse(p.is_excellence_route(provider, url, gateway))
        self.assertFalse(p.is_excellence_route("openrouter", gateway, gateway))
        self.assertFalse(p.is_excellence_route("custom", gateway))

    def test_company_memory_does_not_use_local_hermes_storage(self):
        for caps in (p.BOUND, p.STANDARD, {**p.FREE, "local_memory": "denied"}):
            self.assertEqual(p.decide(snap(caps), "memory").action, "block")
        self.assertIn("Excellence", p.decide(snap(p.BOUND), "memory").message)
        self.assertEqual(p.decide(snap(p.FREE), "memory").action, "allow")

    def test_missing_trusted_lists_do_not_become_unrestricted_access(self):
        for tool in ("write_file", "patch"):
            self.assertEqual(p.decide(snap(p.FREE), tool, {"path": "/etc/passwd"}).action, "block")
            self.assertEqual(p.decide(snap({**p.FREE, "local_files": "free"}), tool).action, "allow")
        self.assertIn("projektmappa", p.decide(snap(p.FREE), "write_file").message)
        self.assertEqual(p.decide(snap({**p.STANDARD, "human_approval": "none"}), "browser_navigate", {"url": "https://evil.example"}).action, "block")
        self.assertEqual(p.decide(snap(p.FREE), "browser_navigate").action, "allow")
        self.assertEqual(p.decide(snap(p.BOUND), "skill_view", {"name": "unapproved"}).action, "block")
        self.assertEqual(p.decide(snap(p.BOUND), "skills_list").action, "allow")
        self.assertEqual(p.decide(snap(p.FREE), "skill_view").action, "allow")

    def test_shell_allow_is_json_object(self):
        self.assertEqual(p.hook_body(p.Decision("allow", "")), {})
        body = p.hook_body(p.Decision("block", "nem"))
        self.assertEqual(body["action"], "block")
        self.assertEqual(body["message"], "nem")


if __name__ == "__main__":
    unittest.main()
