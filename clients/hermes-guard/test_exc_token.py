"""exc-token cache + hibaágak. Futtatás: python3 clients/hermes-guard/test_exc_token.py"""
import json, os, tempfile, unittest
import exc_token as x

CONFIG = """model:
  provider: excellence
mcp_servers:
  other:
    url: https://other.example/api/mcp/zzz
  excellence:
    url: https://ai.example.com/api/mcp/acme
    auth: oauth
    headers:
      X-Excellence-Agent-Id: 33333333-3333-4333-8333-333333333333
"""


def profile(config=CONFIG, token=True):
    home = tempfile.mkdtemp()
    open(os.path.join(home, "config.yaml"), "w").write(config)
    if token:
        os.makedirs(os.path.join(home, "mcp-tokens"))
        json.dump({"access_token": "oauth-abc"}, open(os.path.join(home, "mcp-tokens", "excellence.json"), "w"))
    os.environ["EXC_INSTALL_ID"] = "inst-1"
    return home


class T(unittest.TestCase):
    def test_cache_until_exp_minus_60(self):
        home, calls, clock = profile(), [], [1000]
        def fetcher(origin, tenant, agent, inst, access):
            calls.append((origin, tenant, agent, inst, access))
            return f"jwt{len(calls)}", 1600
        get = lambda: x.get_token(home, now=lambda: clock[0], fetcher=fetcher)
        self.assertEqual(get(), "jwt1")
        self.assertEqual(calls[0], ("https://ai.example.com", "acme", "33333333-3333-4333-8333-333333333333", "inst-1", "oauth-abc"))
        clock[0] = 1539
        self.assertEqual(get(), "jwt1")  # lejárat előtt nincs szerverhívás
        self.assertEqual(len(calls), 1)
        clock[0] = 1541  # exp - 60 után
        self.assertEqual(get(), "jwt2")
        self.assertEqual(len(calls), 2)

    def test_other_agent_misses_cache(self):
        home, calls = profile(), []
        f = lambda *a: (calls.append(a) or "j", 9999999999)
        x.get_token(home, now=lambda: 1, fetcher=f)
        open(os.path.join(home, "config.yaml"), "w").write(CONFIG.replace("33333333", "44444444"))
        x.get_token(home, now=lambda: 2, fetcher=f)
        self.assertEqual(len(calls), 2)

    def test_missing_pieces_fail_in_plain_language(self):
        with self.assertRaisesRegex(x.Fail, "Jelentkezz be újra"):
            x.get_token(profile(token=False), fetcher=lambda *a: ("j", 1))
        with self.assertRaisesRegex(x.Fail, "nincs beállított"):
            x.get_token(profile(config="mcp_servers:\n  excellence:\n    url: https://a/api/mcp/t\n"), fetcher=lambda *a: ("j", 1))


if __name__ == "__main__":
    unittest.main()
