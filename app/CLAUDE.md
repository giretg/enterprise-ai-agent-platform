@AGENTS.md

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Futó app + ellenőrzés (lokálisan és a felhőkonténerben is)

- Indítás: `npm run dev:setup -- --start` (az `app/` könyvtárból) — helyi Postgres, migráció, seed, dev szerver a 3000-es porton, belépés nélkül admin + superadmin. Idempotens, munkamenet elején nyugodtan futtasd.
- UI-változás után nézd meg a képernyőt: `npm run screenshot -- /control-plane/<oldal>` (PNG: `.data/screenshots/`), és olvasd be a képet.
- Push előtt: `npm run ci:local` (a `ci.yml` app-jobjai helyben). A felhőkonténerben DNS hiányában a `test:http-api` / `test:enterprise-tools` SSRF-esetei elbukhatnak — ez környezeti, nem regresszió.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
