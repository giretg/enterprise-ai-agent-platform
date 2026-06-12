# Enterprise AI Agent Platform — MVP Prototípus

Kattintható UI mockup a **Kontrollált Enterprise AI Agent Platform** koncepcióhoz.

- **Control Plane** — governance, board, ticketek, audit
- **Sandbox** — könyvelő agent munkatér, számlafeldolgozás

> Prototípus: mock adatok, szimulált logika, nincs valódi backend vagy LLM.

## Dokumentáció

- [`../AI-Agent-Platform-Koncepcio.md`](../AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`../AI-Agent-Platform-MVP-Terv.md`](../AI-Agent-Platform-MVP-Terv.md) — MVP fejlesztési terv

## Demó-forgatókönyv (M1)

1. Control Plane → Áttekintés
2. Sandbox → Számla feltöltése
3. Agent szimulált feldolgozás → javaslat
4. Küldés jóváhagyásra → ticket a boardon
5. Ticket megnyitása → Jóváhagy → Done + audit

## Futtatás

```bash
cd app
npm install
npm run dev
```

Nyisd meg: http://localhost:5173

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
