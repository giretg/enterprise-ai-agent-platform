# Enterprise AI Agent Platform — MVP Prototípus

Kattintható UI mockup a **Kontrollált Enterprise AI Agent Platform** koncepcióhoz.

- **Control Plane** — governance, board, ticketek, audit
- **Sandbox** — könyvelő agent munkatér, számlafeldolgozás

> Prototípus: mock adatok, szimulált logika, nincs valódi backend vagy LLM.

## Dokumentáció

- [`../AI-Agent-Platform-Koncepcio.md`](../AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`../AI-Agent-Platform-MVP-Terv.md`](../AI-Agent-Platform-MVP-Terv.md) — MVP fejlesztési terv

## Demó-forgatókönyv

1. Control Plane → Áttekintés
2. Sandbox → Számla feltöltése → jóváhagyásra küldés
3. Board → ticket jóváhagyás (Awaiting Human)
4. **TKT-1030** tanítási ticket → memória diff jóváhagyás
5. **Könyvelő Agent** anatómia → memória verzió + **Rollback**
6. **Audit log** → teljes, szűrhető napló
7. **Agent wizard** → `/control-plane/agents/new`
8. **Erőforrás-katalógus** → `/control-plane/resources`
9. **Model Gateway** → `/control-plane/models`
10. **Playbook** → `/control-plane/playbook` (Sandbox demó után frissül)
11. **IAM** → `/control-plane/iam` (emberek + agent service accountok)
12. **Admin** → `/control-plane/admin` (tickettípusok, állapotgép, jóváhagyási láncok)

## Futtatás

```bash
cd app
npm install
npm run dev
```

Nyisd meg: http://localhost:5173

## Firebase Hosting

Projekt: **enterprise-ai-demo**  
Élő URL (deploy után): https://enterprise-ai-demo.web.app

### Előkészítés (egyszer)

```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest use enterprise-ai-demo
```

Opcionális: másold `app/.env.example` → `app/.env` (a build env var-okat onnan olvassa).

### Deploy

```bash
cd app
npm run deploy
```

Ez buildeli a Vite appot (`app/dist`) és feltölti Firebase Hostingra. SPA routing: minden útvonal `index.html`-re irányul (`firebase.json` rewrite).

### Firebase SDK

Az app inicializálja a Firebase-t és (böngészőben) az Analytics-t: `app/src/shared/firebase/index.ts`.

## Technológia

- React 19 + Vite + TypeScript
- Tailwind CSS v4
- React Router
- Kliens oldali mock state (DemoContext)

## Struktúra

```
app/src/
  control-plane/   # 1. app — irányítóközpont
  sandbox/         # 2. app — munkatér
  shared/          # mock adat, típusok, közös UI
```
