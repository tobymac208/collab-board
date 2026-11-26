import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comparePositions } from "@collab/shared";
import {
  login,
  only,
  signup,
  startServer,
  useTestDb,
  type TestClient,
  type TestServer,
} from "../test/harness.ts";
import { pruneHistory } from "./store.ts";

const getDb = useTestDb();
let server: TestServer;
const clients: TestClient[] = [];

beforeEach(async () => {
  server = await startServer(getDb());
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

async function connect(cookie: string) {
  const client = await login(server, cookie);
  clients.push(client);
  return client;
}

async function setup() {
  const owner = await signup(server);
  const client = await connect(owner.cookie);
  const { board } = only(
    await client.request({ type: "create_board", name: "Resilient" }),
    "board_upserted",
  );
  const snap = only(
    await client.request({ type: "open_board", boardId: board.id }),
    "board_snapshot",
  );
  const column = [...snap.columns].sort(comparePositions)[0]!;
  return { owner, client, board, snap, column };
}

const addCard = async (client: TestClient, columnId: string, title: string) =>
  only(await client.request({ type: "create_card", columnId, title }), "card_upserted").card;

const revisionNow = async (client: TestClient, boardId: string) =>
  only(await client.request({ type: "open_board", boardId }), "board_snapshot").revision;

describe("catching up after a reconnect", () => {
  it("sends only the changes since the client's revision, in order", async () => {
    const { owner, client, board, snap, column } = await setup();
    const away = await connect(owner.cookie);
    await away.request({ type: "open_board", boardId: board.id });
    away.close(); // goes offline at snap.revision

    const card = await addCard(client, column.id, "while you were away");
    await client.request({ type: "rename_column", columnId: column.id, name: "Renamed" });
    await client.request({ type: "delete_card", cardId: card.id });

    const back = await connect(owner.cookie);
    const events = await back.request({
      type: "open_board",
      boardId: board.id,
      sinceRevision: snap.revision,
    });
    expect(events.map((e) => e.type)).toEqual(["card_upserted", "column_upserted", "card_deleted"]);
    expect(events.map((e) => ("revision" in e ? e.revision : null))).toEqual([
      snap.revision + 1,
      snap.revision + 2,
      snap.revision + 3,
    ]);
  });

  it("subscribes the client as usual, so later changes arrive live", async () => {
    const { owner, client, board, snap, column } = await setup();
    const back = await connect(owner.cookie);
    await back.request({ type: "open_board", boardId: board.id, sinceRevision: snap.revision });
    await back.drain();
    await addCard(client, column.id, "live");
    expect((await back.drain()).map((m) => m.type)).toContain("card_upserted");
  });

  it("sends nothing when the client is already up to date", async () => {
    const { client, board, snap } = await setup();
    expect(
      await client.request({ type: "open_board", boardId: board.id, sinceRevision: snap.revision }),
    ).toEqual([]);
  });

  it("falls back to a snapshot once the history has been pruned", async () => {
    const { client, board, snap, column } = await setup();
    await addCard(client, column.id, "old news");
    await sql`UPDATE board_changes SET created_at = now() - interval '8 days'`.execute(server.db);
    await pruneHistory(server.db, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

    const events = await client.request({
      type: "open_board",
      boardId: board.id,
      sinceRevision: snap.revision,
    });
    expect(events.map((e) => e.type)).toEqual(["board_snapshot"]);
  });

  it("falls back to a snapshot for a revision the board never reached", async () => {
    const { client, board, snap } = await setup();
    const events = await client.request({
      type: "open_board",
      boardId: board.id,
      sinceRevision: snap.revision + 50,
    });
    expect(events.map((e) => e.type)).toEqual(["board_snapshot"]);
  });

  it("still refuses non-members", async () => {
    const { board } = await setup();
    const outsider = await connect((await signup(server)).cookie);
    await expect(
      outsider.request({ type: "open_board", boardId: board.id, sinceRevision: 0 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("applying a change at most once", () => {
  it("answers a resent change with the original result and changes nothing", async () => {
    const { owner, client, board, column } = await setup();
    const watcher = await connect(owner.cookie);
    await watcher.request({ type: "open_board", boardId: board.id });
    await watcher.drain();

    const opId = randomUUID();
    const send = () =>
      client.request({ type: "create_card", columnId: column.id, title: "once", opId });
    const first = only(await send(), "card_upserted");
    const again = only(await send(), "card_upserted");

    expect(again.card).toEqual(first.card);
    expect(again.revision).toBe(first.revision);
    const snap = only(
      await client.request({ type: "open_board", boardId: board.id }),
      "board_snapshot",
    );
    expect(snap.cards.filter((c) => c.title === "once")).toHaveLength(1);
    expect(snap.revision).toBe(first.revision);
    // The watcher saw the change once, not twice.
    expect(
      (await watcher.drain()).filter((m) => m.type === "card_upserted").map((m) => m.type),
    ).toEqual(["card_upserted"]);
  });

  it("answers a resent delete with the original result, not 'not found'", async () => {
    const { client, column } = await setup();
    const card = await addCard(client, column.id, "doomed");
    const opId = randomUUID();
    const first = await client.request({ type: "delete_card", cardId: card.id, opId });
    const again = await client.request({ type: "delete_card", cardId: card.id, opId });
    expect(again).toEqual(first.map((e) => ({ ...e, requestId: again[0]!.requestId })));
  });

  it("doesn't apply a move twice", async () => {
    const { client, board, snap, column } = await setup();
    const [a, b, c] = [
      await addCard(client, column.id, "a"),
      await addCard(client, column.id, "b"),
      await addCard(client, column.id, "c"),
    ];
    const opId = randomUUID();
    const move = { type: "move_card", cardId: a.id, toColumnId: column.id, opId } as const;
    await client.request({ ...move, afterId: c.id, beforeId: null });
    // A resend with the same opId is ignored even if the surroundings changed.
    await client.request({
      type: "move_card",
      cardId: b.id,
      toColumnId: column.id,
      afterId: a.id,
      beforeId: null,
    });
    await client.request({ ...move, afterId: c.id, beforeId: null });
    const latest = only(
      await client.request({ type: "open_board", boardId: board.id }),
      "board_snapshot",
    );
    expect(
      latest.cards
        .filter((card) => card.columnId === column.id)
        .sort(comparePositions)
        .map((card) => card.title),
    ).toEqual(["c", "a", "b"]);
    expect(latest.revision).toBe(snap.revision + 5);
  });

  it("applies the same op sent from two tabs at once only once", async () => {
    const { owner, client, board, column } = await setup();
    const otherTab = await connect(owner.cookie);
    const before = await revisionNow(client, board.id);
    const opId = randomUUID();
    const body = { type: "create_card", columnId: column.id, title: "racing", opId } as const;
    const [one, two] = await Promise.all([client.request(body), otherTab.request(body)]);
    expect(only(one, "card_upserted").card.id).toBe(only(two, "card_upserted").card.id);
    expect(await revisionNow(client, board.id)).toBe(before + 1);
  });

  it("refuses an opId someone else already used", async () => {
    const { owner, client, board, column } = await setup();
    const other = await signup(server);
    await client.request({ type: "add_member", boardId: board.id, email: other.user.email });
    const intruder = await connect(other.cookie);
    const opId = randomUUID();
    await client.request({ type: "create_card", columnId: column.id, title: "mine", opId });
    await expect(
      intruder.request({ type: "create_card", columnId: column.id, title: "theirs", opId }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(owner.user.id).toBeDefined();
  });

  it("retries a change that failed, since nothing was recorded", async () => {
    const { client, column } = await setup();
    const opId = randomUUID();
    const id = randomUUID();
    await client.request({ type: "create_card", columnId: column.id, title: "taken", id });
    await expect(
      client.request({ type: "create_card", columnId: column.id, title: "dup", id, opId }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Same opId, now with a free id: it's applied this time.
    const ok = await client.request({
      type: "create_card",
      columnId: column.id,
      title: "retry",
      id: randomUUID(),
      opId,
    });
    expect(only(ok, "card_upserted").card.title).toBe("retry");
  });
});

describe("pruneHistory", () => {
  it("removes old log and applied-op entries but keeps recent ones", async () => {
    const { client, column } = await setup();
    await addCard(client, column.id, "old");
    await sql`UPDATE board_changes SET created_at = now() - interval '8 days'`.execute(server.db);
    await sql`UPDATE applied_ops SET created_at = now() - interval '8 days'`.execute(server.db);
    await addCard(client, column.id, "new");

    await pruneHistory(server.db, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const count = async (table: "board_changes" | "applied_ops") =>
      (await server.db.selectFrom(table).select("revision").execute()).length;
    expect(await count("board_changes")).toBe(1);
    expect(await count("applied_ops")).toBe(1);
  });
});
