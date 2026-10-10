"""Plugin betöltés a pinelt hook-szerződés ellen, Hermes bináris nélkül.

A pinelt Hermes (v0.21.5 @ d0288be5) ezen a gépen nincs telepítve. A smoke azt
ellenőrzi, hogy a `register(ctx)` a dokumentált hookokat és az `llm_execution`
middleware-t köti, és egy mintahívásra a cache-elt policy szerint dönt.
"""
import importlib.util
import io
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "excellence-guard"))
import policy
import runtime

PLUGIN = os.path.join(os.path.dirname(__file__), "excellence-guard", "__init__.py")


class Ctx:
    def __init__(self):
        self.hooks = {}
        self.middleware = {}
        self.sections = []

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_middleware(self, name, callback):
        self.middleware[name] = callback

    def register_system_prompt_section(self, section_id, text, position=None, max_chars=None):
        self.sections.append((section_id, text, position, max_chars))


def load_plugin():
    spec = importlib.util.spec_from_file_location("excellence_guard_plugin", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Smoke(unittest.TestCase):
    def test_registers_and_decides_sample_call(self):
        home = tempfile.mkdtemp()
        os.environ["HERMES_HOME"] = home
        os.environ["EXC_GUARD_OFFLINE"] = "1"
        os.environ["EXC_GUARD_DISABLE_BACKGROUND"] = "1"
        runtime.write_json(
            runtime._under(home, runtime.CACHE_FILE),
            {"cachedAt": time.time(), "revoked": False, "snapshot": policy.snapshot_of(policy.FREE, version="free")},
        )
        mod = load_plugin()
        mod._guard = None
        ctx = Ctx()
        ctx_stderr = sys.stderr
        try:
            mod.register(ctx)
            self.assertEqual(
                set(ctx.hooks),
                {"on_session_start", "on_session_end", "pre_tool_call", "post_tool_call", "pre_llm_call", "post_llm_call"},
            )
            self.assertIn("llm_execution", ctx.middleware)
            self.assertEqual(ctx.sections[0][0], "excellence-guard.notice")
            self.assertIn("naplózásra kerülnek", ctx.sections[0][1])
            err = io.StringIO()
            sys.stderr = err
            ctx.hooks["on_session_start"](session_id="s-notice")
            self.assertIn(policy.NOTICE, err.getvalue())

            self.assertIsNone(ctx.hooks["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s", tool_call_id="1"))
            blocked = ctx.hooks["pre_tool_call"](tool_name="mcp__github__search", args={}, session_id="s", tool_call_id="2")
            self.assertEqual(blocked["action"], "block")
            self.assertIn("github", blocked["message"])

            runtime.write_json(
                runtime._under(home, runtime.CACHE_FILE),
                {"cachedAt": time.time(), "revoked": False, "snapshot": policy.snapshot_of(policy.BOUND, version="bound")},
            )
            billing = ctx.hooks["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s", tool_call_id="3")
            self.assertEqual(billing["action"], "block")
            self.assertIn("rendszergazdát", billing["message"])

            delegated = ctx.hooks["pre_tool_call"](tool_name="delegate_task", args={"goal": "számla"}, session_id="s", tool_call_id="4")
            self.assertEqual(delegated["action"], "block")
        finally:
            os.environ.pop("EXC_GUARD_OFFLINE", None)
            os.environ.pop("EXC_GUARD_DISABLE_BACKGROUND", None)
            os.environ.pop("HERMES_HOME", None)
            sys.stderr = ctx_stderr


if __name__ == "__main__":
    unittest.main()
