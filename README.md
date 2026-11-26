# Collab Board

A real-time collaborative kanban board. Several people open the same board and see each other's
edits instantly, with no refreshing.

The interesting part is the sync engine, not the kanban UI. This project is built in phases, each
one taking on a harder problem in real-time collaboration: conflict handling, ordering under
concurrent edits, reconnects and offline edits, CRDTs, and horizontal scaling.

> **Status:** phase 2. Everyone viewing a board sees each other's changes live, along with
> who else is there. Edits aren't optimistic yet, and conflicting edits are last-writer-wins;
> that's phase 3.

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
  `ack` or `error`.
- **Real time:** opening a board subscribes the socket to it. Every change is sent to the
  board's other viewers as the same state events, and board-list changes (renames, deletes,
  being added to a board) go to every member. An in-memory hub on the server tracks who is
  viewing what; phase 6 puts Redis behind it.
- **Revisions:** every change to a board increments `boards.revision` in the same transaction,
  which also queues concurrent writes to one board. Events carry their revision; clients apply
  them in order, hold back early arrivals, and reload the board if a gap doesn't fill.
- **Presence:** the board header shows who has the board open, once per person however many
  tabs they use.
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
| 1. Foundation ✅        | Auth, boards, columns, cards, drag and drop, Postgres                         |
| 2. Real-time 🚧         | Broadcast board changes to everyone viewing a board                           |
| 3. Correctness          | Optimistic updates, conflict handling, stable ordering under concurrent edits |
| 4. Resilience           | Reconnect and catch up on missed changes, offline edits                       |
| 5. Collaboration engine | CRDTs (Yjs first, then a hand-rolled version)                                 |
| 6. Scale                | Multiple server instances with Redis pub/sub, load tests, metrics             |

## License

MIT
