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

    def test_key_cmd_payload_tells_hermes_the_real_lifetime(self):
        # Hermes bare tokenre 900 s-ot feltételez (nincs TTL); a JWT 600 s → az expires_in-nek kell hordoznia.
        self.assertEqual(json.loads(x.key_cmd_payload("jwt", 1600, now=lambda: 1000)), {"access_token": "jwt", "expires_in": 600})
        self.assertEqual(json.loads(x.key_cmd_payload("jwt", 900, now=lambda: 1000))["expires_in"], 1)

    def test_get_token_exp_returns_expiry_from_cache_and_fetch(self):
        home, calls, clock = profile(), [], [1000]
        f = lambda *a: (calls.append(a) or "jwt1", 1600)
        self.assertEqual(x.get_token_exp(home, now=lambda: clock[0], fetcher=f), ("jwt1", 1600))
        clock[0] = 1200
        self.assertEqual(x.get_token_exp(home, now=lambda: clock[0], fetcher=f), ("jwt1", 1600))
        self.assertEqual(len(calls), 1)

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
            x.get_token(profile(config="model:\n  provider: excellence\n"), fetcher=lambda *a: ("j", 1))

    def test_bot_profile_uses_parent_mcp_token(self):
        # Vékony Bot: a belépés a default Hermes-profilban van, a Botnak saját HERMES_HOME-ja.
        root = tempfile.mkdtemp()
        bot = os.path.join(root, "profiles", "exc-reka")
        os.makedirs(bot)
        open(os.path.join(bot, "config.yaml"), "w").write(CONFIG)
        os.makedirs(os.path.join(root, "mcp-tokens"))
        json.dump({"access_token": "oauth-parent"}, open(os.path.join(root, "mcp-tokens", "excellence.json"), "w"))
        os.environ["EXC_INSTALL_ID"] = "inst-1"
        calls = []
        x.get_token(bot, now=lambda: 1, fetcher=lambda *a: (calls.append(a) or "jwt-bot", 9999999999))
        self.assertEqual(calls[0][4], "oauth-parent")
        self.assertEqual(calls[0][2], "33333333-3333-4333-8333-333333333333")

    def test_share_mcp_tokens_copies_excellence_files_into_bot(self):
        root = tempfile.mkdtemp()
        bot = os.path.join(root, "profiles", "exc-reka")
        os.makedirs(bot)
        os.makedirs(os.path.join(root, "mcp-tokens"))
        json.dump({"access_token": "oauth-parent"}, open(os.path.join(root, "mcp-tokens", "excellence.json"), "w"))
        json.dump({"client_id": "cid"}, open(os.path.join(root, "mcp-tokens", "excellence.client.json"), "w"))
        open(os.path.join(root, "mcp-tokens", "other.json"), "w").write("{}")
        self.assertTrue(x.share_mcp_tokens(bot))
        dest = os.path.join(bot, "mcp-tokens")
        self.assertEqual(json.load(open(os.path.join(dest, "excellence.json")))["access_token"], "oauth-parent")
        self.assertTrue(os.path.isfile(os.path.join(dest, "excellence.client.json")))
        self.assertFalse(os.path.exists(os.path.join(dest, "other.json")))
        self.assertFalse(x.share_mcp_tokens(root))

    def test_fresher_bot_login_is_not_overwritten_by_parent(self):
        # #895: 24 h után a Bot Hermese frissít; a default profil lejárt másolata ne írja vissza.
        root = tempfile.mkdtemp()
        bot = os.path.join(root, "profiles", "exc-reka")
        for d in (os.path.join(root, "mcp-tokens"), os.path.join(bot, "mcp-tokens")):
            os.makedirs(d)
        open(os.path.join(bot, "config.yaml"), "w").write(CONFIG)
        write = lambda home, name, body: json.dump(body, open(os.path.join(home, "mcp-tokens", name), "w"))
        write(root, "excellence.json", {"access_token": "oauth-old", "expires_at": 100})
        write(root, "excellence.client.json", {"client_id": "old"})
        write(bot, "excellence.json", {"access_token": "oauth-new", "expires_at": 200})
        write(bot, "excellence.client.json", {"client_id": "new"})
        self.assertFalse(x.share_mcp_tokens(bot))
        self.assertEqual(json.load(open(os.path.join(bot, "mcp-tokens", "excellence.json")))["access_token"], "oauth-new")
        self.assertEqual(json.load(open(os.path.join(bot, "mcp-tokens", "excellence.client.json")))["client_id"], "new")
        self.assertEqual(x.mcp_access_token(bot), "oauth-new")
        # A Bot frissítése elforgatta a refresh tokent: visszakerül a default profilba (a többi Bot onnan kapja).
        self.assertEqual(json.load(open(os.path.join(root, "mcp-tokens", "excellence.json")))["access_token"], "oauth-new")
        self.assertEqual(json.load(open(os.path.join(root, "mcp-tokens", "excellence.client.json")))["client_id"], "new")
        # Újra-belépés a default profilban: az a frissebb, átmegy.
        write(root, "excellence.json", {"access_token": "oauth-relogin", "expires_at": 300})
        self.assertTrue(x.share_mcp_tokens(bot))
        self.assertEqual(x.mcp_access_token(bot), "oauth-relogin")

    def test_bot_takes_parent_login_by_url_not_by_name(self):
        # Valós eset: a default `excellence` saját tenantra mutat (lejárt), a Bot tenantjára tett
        # belépés `excellence-acme` néven áll. A Bot csak az azonos URL-ű belépőt veheti át.
        root = tempfile.mkdtemp()
        bot = os.path.join(root, "profiles", "exc-reka")
        for d in (os.path.join(root, "mcp-tokens"), os.path.join(bot, "mcp-tokens")):
            os.makedirs(d)
        open(os.path.join(bot, "config.yaml"), "w").write(CONFIG)
        open(os.path.join(root, "config.yaml"), "w").write(
            "mcp_servers:\n  excellence:\n    url: https://ai.example.com/api/mcp/own\n    auth: oauth\n"
            "  excellence-acme:\n    url: https://ai.example.com/api/mcp/acme\n    auth: oauth\n    oauth:\n      client_id: cid\n"
        )
        write = lambda home, name, body: json.dump(body, open(os.path.join(home, "mcp-tokens", name), "w"))
        write(root, "excellence.json", {"access_token": "oauth-own", "expires_at": 900})
        write(root, "excellence-acme.json", {"access_token": "oauth-acme", "expires_at": 500})
        write(root, "excellence-acme.client.json", {"client_id": "cid"})
        write(bot, "excellence.json", {"access_token": "oauth-stale", "expires_at": 100})
        self.assertEqual(x.parent_server_name(bot, root), "excellence-acme")
        self.assertTrue(x.share_mcp_tokens(bot))
        self.assertEqual(x.mcp_access_token(bot), "oauth-acme")
        self.assertEqual(json.load(open(os.path.join(bot, "mcp-tokens", "excellence.client.json")))["client_id"], "cid")
        self.assertFalse(os.path.exists(os.path.join(bot, "mcp-tokens", "excellence-acme.json")))
        # Ha a default profilban nincs azonos URL-ű belépő, más tenant tokenje nem kerül át.
        open(os.path.join(root, "config.yaml"), "w").write("mcp_servers:\n  excellence:\n    url: https://ai.example.com/api/mcp/own\n")
        self.assertIsNone(x.parent_server_name(bot, root))
        self.assertFalse(x.share_mcp_tokens(bot))

    def test_share_all_from_default_home_reaches_every_bot(self):
        # Hermes desktop: egy folyamat, HERMES_HOME=~/.hermes. A Guard és a telepítő innen indul;
        # minden exc-* Bot az azonos URL-ű belépőt kapja, név szerint nem.
        root = tempfile.mkdtemp()
        os.makedirs(os.path.join(root, "mcp-tokens"))
        open(os.path.join(root, "config.yaml"), "w").write(
            "mcp_servers:\n  excellence:\n    url: https://ai.example.com/api/mcp/own\n"
            "  excellence-acme:\n    url: https://ai.example.com/api/mcp/acme\n"
        )
        write = lambda path, body: json.dump(body, open(path, "w"))
        write(os.path.join(root, "mcp-tokens", "excellence.json"), {"access_token": "oauth-own", "expires_at": 900})
        write(os.path.join(root, "mcp-tokens", "excellence-acme.json"), {"access_token": "oauth-acme", "expires_at": 500})
        bots = {}
        for name in ("exc-alfred", "exc-reka", "plain"):
            bots[name] = os.path.join(root, "profiles", name)
            os.makedirs(os.path.join(bots[name], "mcp-tokens"))
            open(os.path.join(bots[name], "config.yaml"), "w").write(CONFIG)
            write(os.path.join(bots[name], "mcp-tokens", "excellence.json"), {"access_token": "oauth-own", "expires_at": 100})
        self.assertTrue(x.share_all_mcp_tokens(root))
        self.assertEqual(x.mcp_access_token(bots["exc-alfred"]), "oauth-acme")
        self.assertEqual(x.mcp_access_token(bots["exc-reka"]), "oauth-acme")
        self.assertEqual(json.load(open(os.path.join(bots["plain"], "mcp-tokens", "excellence.json")))["access_token"], "oauth-own")
        # Bot-profilból hívva csak az az egy Bot.
        self.assertFalse(x.share_all_mcp_tokens(bots["exc-reka"]))

    def test_profile_without_agent_asks_for_bootstrap_token(self):
        # Alap profil (#858): nincs X-Excellence-Agent-Id → agentId nélküli kérés, a szerver választ.
        home, calls = profile(config="mcp_servers:\n  excellence:\n    url: https://a/api/mcp/t\n"), []
        x.get_token(home, now=lambda: 1, fetcher=lambda *a: (calls.append(a) or "j", 9999999999))
        self.assertEqual(calls[0][:4], ("https://a", "t", None, "inst-1"))
        sent = {}
        class R:
            def __enter__(s): return s
            def __exit__(s, *a): pass
            def read(s): return b'{"token": "j", "expiresAt": "2030-01-01T00:00:00Z"}'
        def urlopen(req, timeout):
            sent.update(json.loads(req.data))
            return R()
        orig, x.urllib.request.urlopen = x.urllib.request.urlopen, urlopen
        try:
            x.fetch("https://a", "t", None, "inst-1", "oauth-abc")
        finally:
            x.urllib.request.urlopen = orig
        self.assertEqual(sent, {"tenantSlug": "t", "installId": "inst-1"})


if __name__ == "__main__":
    unittest.main()
