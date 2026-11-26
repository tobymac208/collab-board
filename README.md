# Collab Board

A real-time collaborative kanban board. Several people open the same board and see each other's
edits instantly, with no refreshing.

The interesting part is the sync engine, not the kanban UI. This project is built in phases, each
one taking on a harder problem in real-time collaboration: conflict handling, ordering under
concurrent edits, reconnects and offline edits, CRDTs, and horizontal scaling.

> **Status:** phase 1. Accounts, boards, columns and cards with drag and drop, persisted in
> Postgres. Changes aren't broadcast to other viewers yet; that's phase 2.

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

### How it fits together

- **Auth** is a small HTTP API on the server (`/auth/signup`, `/auth/login`, `/auth/logout`,
  `/auth/me`). Passwords are hashed with scrypt; sessions are random tokens in an httpOnly,
  `SameSite=Lax` cookie, stored hashed in Postgres. The WebSocket upgrade checks the same cookie.
- **Board data** flows over the WebSocket. Clients send requests (`create_card`, `move_card`, ...)
  with a `requestId`; the server replies with state events (`card_upserted`, ...) and then an
  `ack` or `error`. The same events will be broadcast to other viewers in phase 2.
- **Ordering** uses [fractional indexing](https://github.com/rocicorp/fractional-indexing): each
  column and card has a string `position`, and a move writes only the moved row. Positions use
  `COLLATE "C"` so Postgres sorts them byte-wise, matching the client.
- **Permissions:** board owners can rename, delete and invite people by email; editors can
  change columns and cards. Non-members get `not_found`, so board ids can't be probed.

Server tests run against [PGlite](https://pglite.dev) (Postgres compiled to WASM), so
`pnpm test` and CI need no database.

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
| 1. Foundation 🚧        | Auth, boards, columns, cards, drag and drop, Postgres                         |
| 2. Real-time            | Broadcast board changes to everyone viewing a board                           |
| 3. Correctness          | Optimistic updates, conflict handling, stable ordering under concurrent edits |
| 4. Resilience           | Reconnect and catch up on missed changes, offline edits                       |
| 5. Collaboration engine | CRDTs (Yjs first, then a hand-rolled version)                                 |
| 6. Scale                | Multiple server instances with Redis pub/sub, load tests, metrics             |

## License

MIT
