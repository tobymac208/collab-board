# Collab Board

A real-time collaborative kanban board. Several people open the same board and see each other's
edits instantly, with no refreshing.

The interesting part is the sync engine, not the kanban UI. This project is built in phases, each
one taking on a harder problem in real-time collaboration: conflict handling, ordering under
concurrent edits, reconnects and offline edits, CRDTs, and horizontal scaling.

> **Status:** project skeleton. The browser connects to the WebSocket server; boards are next.

## Architecture

```
┌──────────────────────┐     WebSocket (JSON, zod-validated)     ┌──────────────────────┐
│  apps/web            │ ◄─────────────────────────────────────► │  apps/server         │
│  Next.js + React     │                                         │  Node + ws           │
└──────────────────────┘                                         └──────────┬───────────┘
            ▲                                                               │
            │ shared message types                                          ▼
     packages/shared ──────────────────────────────────────────►      PostgreSQL
```

| Path              | What it is                                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| `apps/web`        | Next.js frontend                                                           |
| `apps/server`     | Stateful WebSocket server (needs long-lived connections, so not on Vercel) |
| `packages/shared` | Wire protocol schemas and types used by both sides                         |

## Running locally

Requirements: Node 26+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up        # start Postgres in Docker
pnpm dev          # web on http://localhost:3000, server on http://localhost:4000
```

| Command          | What it does                       |
| ---------------- | ---------------------------------- |
| `pnpm dev`       | Run web and server with hot reload |
| `pnpm test`      | Run all tests                      |
| `pnpm typecheck` | Type-check every package           |
| `pnpm lint`      | Lint                               |
| `pnpm build`     | Production builds                  |
| `pnpm format`    | Format with Prettier               |
| `pnpm db:down`   | Stop Postgres                      |

## Roadmap

| Phase                   | Scope                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| 0. Skeleton ✅          | Monorepo, WebSocket handshake, protocol validation, CI                        |
| 1. Foundation           | Auth, boards, columns, cards, drag and drop, Postgres                         |
| 2. Real-time            | Broadcast board changes to everyone viewing a board                           |
| 3. Correctness          | Optimistic updates, conflict handling, stable ordering under concurrent edits |
| 4. Resilience           | Reconnect and catch up on missed changes, offline edits                       |
| 5. Collaboration engine | CRDTs (Yjs first, then a hand-rolled version)                                 |
| 6. Scale                | Multiple server instances with Redis pub/sub, load tests, metrics             |

## License

MIT
