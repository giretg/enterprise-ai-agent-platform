"""Döntési mátrix: allow / approve / block, ismeretlen MCP, tool-szabály. Futtatás: python3 clients/hermes-guard/test_guard_policy.py"""
import os
import sys
import tempfile
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

    def test_bridge_and_conversation_tools_pass_in_every_preset(self):
        for preset in (p.BOUND, p.STANDARD, p.FREE, {**p.FREE, "human_approval": "always"}):
            for tool in ("tool_search", "tool_describe", "tool_call", "clarify", "todo_list", "todo"):
                self.assertEqual(p.decide(snap(preset), tool).action, "allow", tool)
        # Explicit tiltás viszont nyer (D3) — a passthrough csak szabály nélkül átlátszó.
        denied = snap(p.FREE, ({"pattern": "clarify", "action": "deny", "source": "admin"},))
        self.assertEqual(p.decide(denied, "clarify").action, "block")
        self.assertEqual(p.decide(denied, "tool_search").action, "allow")
        self.assertEqual(p.decide_interpreted({"kind": "bound"}, "clarify").action, "allow")

    def test_unwrapped_tool_call_is_left_to_hermes(self):
        # Két helyi elem: a Hermes nem csomagolja ki, a saját local_batch_error-ja jut a modellhez.
        batch = {"calls": [{"name": "read_file", "arguments": {"path": "a.csv"}},
                           {"name": "read_file", "arguments": {"path": "b.csv"}}]}
        self.assertEqual(p.hook_body(p.decide(snap(p.BOUND), "tool_call", batch)), {})
        # A kicsomagolt belső eszköz továbbra is a képesség szerint dől el.
        self.assertEqual(p.decide(snap(p.BOUND), "read_file").action, "block")

    def test_capability_block_names_axis_not_unknown_tool(self):
        bound = p.decide(snap(p.BOUND), "read_file")
        self.assertIn("helyi fájlt", bound.message)
        self.assertNotIn("nem ismeri", bound.message)
        write = p.decide(snap(p.FREE), "write_file")
        self.assertIn("olvasni viszont engedett", write.message)

    def test_unclassified_tool_is_denied_unless_explicit_rule(self):
        bound = p.decide(snap(p.BOUND), "ha_call_service")
        self.assertEqual(bound.action, "block")
        self.assertTrue(bound.unclassified)
        self.assertIn("még nem ismeri", bound.message)
        self.assertNotIn("céges szabály ezt nem engedi", bound.message)
        free = p.decide(snap(p.FREE), "ha_call_service")
        self.assertEqual(free.action, "block")
        allowed = snap(p.FREE, ({"pattern": "ha_call_service", "action": "allow", "source": "user"},))
        self.assertEqual(p.decide(allowed, "ha_call_service").action, "allow")
        self.assertFalse(p.decide(snap(p.BOUND), "terminal").unclassified)

    def test_external_services_axis(self):
        for preset in (p.BOUND, p.STANDARD):
            blocked = p.decide(snap(preset), "image_generate")
            self.assertEqual(blocked.action, "block")
            self.assertFalse(blocked.unclassified)
            self.assertIn("felhős szolgáltatás", blocked.message)
        self.assertEqual(p.decide(snap({**p.FREE, "human_approval": "none"}), "image_generate").action, "allow")
        self.assertEqual(p.decide(snap(p.FREE), "text_to_speech").action, "allow")
        denied = snap(p.STANDARD, ({"pattern": "image_generate", "action": "allow", "source": "user"},))
        self.assertEqual(p.decide(denied, "image_generate").action, "allow")
        # Hiányzó tengely (régi snapshot) → Kötött pálya szintje: tilt.
        old = {k: v for k, v in p.FREE.items() if k != "external_services"}
        self.assertEqual(p.decide(snap(old), "image_generate").action, "block")

    def test_attachments_only_reads_only_profile_attachments(self):
        with tempfile.TemporaryDirectory() as home:
            att = os.path.join(home, "attachments")
            os.makedirs(att)
            csv = os.path.join(att, "re_EloRend.csv")
            open(csv, "w").close()
            open(os.path.join(home, "config.yaml"), "w").close()
            outside = os.path.join(home, "outside")
            os.makedirs(outside)
            os.symlink(outside, os.path.join(att, "link"))
            caps = snap({**p.BOUND, "local_files": "attachments_only"})

            def run(tool, args):
                return p.decide(caps, tool, args, att)

            self.assertEqual(run("read_file", {"path": csv}).action, "allow")
            self.assertEqual(run("read_file", {"path": "re_EloRend.csv"}).action, "allow")
            self.assertEqual(run("search_files", {"pattern": "x", "path": att}).action, "allow")
            self.assertEqual(run("vision_analyze", {"image_url": os.path.join(att, "a.png")}).action, "allow")
            for path in (os.path.expanduser("~/Documents/x.csv"), os.path.join(att, "..", "config.yaml"),
                         os.path.join(att, "link", "secret.csv"), "../config.yaml", "",
                         "https://x.example/a.png", "data:image/png;base64,xx", "file:///etc/passwd", None):
                blocked = run("read_file", {"path": path})
                self.assertEqual(blocked.action, "block", path)
                self.assertIn("csak csatolmány", blocked.message)
            self.assertEqual(run("search_files", {"pattern": "x"}).action, "block")
            self.assertEqual(run("vision_analyze", {"image_url": "https://x.example/a.png"}).action, "block")
            self.assertEqual(run("write_file", {"path": csv}).action, "block")
            # Csatolmány-mappa nélkül (ismeretlen profil) minden olvasás tilt.
            self.assertEqual(p.decide(caps, "read_file", {"path": csv}).action, "block")

    def test_snapshot_catalog_reclassifies_without_guard_release(self):
        # #872: a snapshot katalógusa felülírja a beépített tartalékot.
        catalog = [{"pattern": "ha_call_service", "class": "capability:local_files:read"},
                   {"pattern": "terminal", "class": "denied"}]
        s = {**snap(p.FREE), "toolCatalog": catalog}
        self.assertEqual(p.decide(s, "ha_call_service").action, "allow")
        self.assertEqual(p.decide({**s, "capabilities": {**p.FREE, "local_files": "none"}}, "ha_call_service").action, "block")
        # Ami a snapshot-katalógusban nincs, az ott besorolatlan, akkor is, ha a tartalékban szerepel.
        self.assertTrue(p.decide(s, "read_file").unclassified)
        # A végleges tiltás nyer az eszközönkénti engedéllyel szemben.
        allow_terminal = {**s, "toolRules": [{"pattern": "terminal", "action": "allow", "source": "user"}]}
        denied = p.decide(allow_terminal, "terminal")
        self.assertEqual(denied.action, "block")
        self.assertIn("véglegesen letiltotta", denied.message)

    def test_catalog_matches_exact_before_longest_prefix(self):
        catalog = [("browser_*", "capability:browser:use"), ("browser_vault_*", "denied"), ("browser_vault_list", "always")]
        self.assertEqual(p.tool_class(catalog, "browser_click"), "capability:browser:use")
        self.assertEqual(p.tool_class(catalog, "browser_vault_fill"), "denied")
        self.assertEqual(p.tool_class(catalog, "browser_vault_list"), "always")
        self.assertIsNone(p.tool_class(catalog, "brows"))
        self.assertEqual(p.catalog_of({"toolCatalog": "garbage"}), p.FALLBACK_CATALOG)

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
        self.assertTrue(p.should_block_llm_egress("https://openrouter.ai/api/v1/chat/completions", gateway))
        self.assertTrue(p.should_block_llm_egress("https://openrouter.ai/api/v1/models", gateway))
        self.assertTrue(p.should_block_llm_egress("https://api.openai.com/v1/chat/completions", gateway))
        self.assertTrue(p.should_block_llm_egress("https://evil.example/v1/chat/completions", gateway))
        self.assertFalse(p.should_block_llm_egress("https://ai.example/api/model-gateway/v1/chat/completions", gateway))
        self.assertFalse(p.should_block_llm_egress("https://ai.example/api/client-policy/heartbeat", gateway))
        self.assertFalse(p.should_block_llm_egress("https://ai.example/api/mcp/tenant", gateway))
        self.assertFalse(p.should_block_llm_egress("https://clerk.example/v1/oauth/token", gateway))

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
