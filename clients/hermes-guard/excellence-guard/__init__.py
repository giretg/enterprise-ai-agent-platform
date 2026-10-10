"""Excellence Guard plugin (#775). A Hermes `register(ctx)`-ét hívja.

Pin: Hermes v0.21.5 @ d0288be5. A hookok és a middleware szerződése a pinelt
`website/docs/user-guide/features/hooks.md` és `developer-guide/middleware.md`.
"""
import os
import sys

_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

import policy
import runtime

_guard = None


def guard():
    global _guard
    if _guard is None:
        home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        _guard = runtime.Guard(home)
    return _guard


def register(ctx):
    g = guard()
    ctx.register_hook("on_session_start", g.on_session_start)
    ctx.register_hook("on_session_end", g.on_session_end)
    ctx.register_hook("pre_tool_call", g.pre_tool_call)
    ctx.register_hook("post_tool_call", g.post_tool_call)
    ctx.register_hook("pre_llm_call", g.pre_llm_call)
    ctx.register_hook("post_llm_call", g.post_llm_call)
    ctx.register_middleware("llm_execution", g.llm_execution)
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if register_section:
        register_section("excellence-guard.notice", policy.NOTICE, position="after_memory", max_chars=500)
    try:
        g.current(force=True)
        g.beat()
    except Exception:
        pass
    g.spawn()
