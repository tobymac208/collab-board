import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comparePositions, type Card } from "@collab/shared";
import {
  login,
  only,
  signup,
  startServer,
  useTestDb,
  type TestClient,
  type TestServer,
} from "../test/harness.ts";

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

/** Two members of one board, both with it open, and a card to fight over. */
async function setup() {
  const aliceAccount = await signup(server);
  const bobAccount = await signup(server);
  const alice = await connect(aliceAccount.cookie);
  const bob = await connect(bobAccount.cookie);
  const { board } = only(
    await alice.request({ type: "create_board", name: "Contested" }),
    "board_upserted",
  );
  await alice.request({ type: "add_member", boardId: board.id, email: bobAccount.user.email });
  const snap = only(
    await alice.request({ type: "open_board", boardId: board.id }),
    "board_snapshot",
  );
  await bob.request({ type: "open_board", boardId: board.id });
  const columns = [...snap.columns].sort(comparePositions);
  const card = only(
    await alice.request({ type: "create_card", columnId: columns[0]!.id, title: "original" }),
    "card_upserted",
  ).card;
  return { alice, bob, board, columns, card, aliceAccount, bobAccount };
}

describe("client-generated ids", () => {
  it("creates cards and columns with the id the client chose", async () => {
    const { alice, board, columns } = await setup();
    const cardId = randomUUID();
    const columnId = randomUUID();
    const card = only(
      await alice.request({
        type: "create_card",
        columnId: columns[0]!.id,
        title: "mine",
        id: cardId,
      }),
      "card_upserted",
    ).card;
    expect(card.id).toBe(cardId);
    const column = only(
      await alice.request({ type: "create_column", boardId: board.id, name: "Mine", id: columnId }),
      "column_upserted",
    ).column;
    expect(column.id).toBe(columnId);
  });

  it("refuses an id that's already taken, even on another board", async () => {
    const { alice, columns, card, aliceAccount } = await setup();
    await expect(
      alice.request({ type: "create_card", columnId: columns[0]!.id, title: "dup", id: card.id }),
    ).rejects.toMatchObject({ code: "conflict" });

    const other = await connect(aliceAccount.cookie);
    const { board } = only(
      await other.request({ type: "create_board", name: "Other" }),
      "board_upserted",
    );
    const snap = only(
      await other.request({ type: "open_board", boardId: board.id }),
      "board_snapshot",
    );
    await expect(
      other.request({
        type: "create_card",
        columnId: snap.columns[0]!.id,
        title: "dup",
        id: card.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("moves by neighbour", () => {
  it("keeps a dropped card next to the neighbour the user saw, despite concurrent inserts", async () => {
    const { alice, bob, board, columns } = await setup();
    const col = columns[1]!.id;
    const add = async (title: string) =>
      only(await alice.request({ type: "create_card", columnId: col, title }), "card_upserted")
        .card;
    const a = await add("A");
    const b = await add("B");
    const x = await add("X");

    // Bob drops N between A and B; Alice, not having seen that yet, drops X
    // between A and B as well. X should land directly after A.
    const n = await add("N");
    await bob.request({
      type: "move_card",
      cardId: n.id,
      toColumnId: col,
      afterId: a.id,
      beforeId: b.id,
    });
    await alice.request({
      type: "move_card",
      cardId: x.id,
      toColumnId: col,
      afterId: a.id,
      beforeId: b.id,
    });

    const snap = only(
      await alice.request({ type: "open_board", boardId: board.id }),
      "board_snapshot",
    );
    const order = snap.cards
      .filter((c) => c.columnId === col)
      .sort(comparePositions)
      .map((c) => c.title);
    expect(order).toEqual(["A", "X", "N", "B"]);
  });

  it("falls back sensibly when the neighbour was deleted meanwhile", async () => {
    const { alice, bob, board, columns } = await setup();
    const col = columns[1]!.id;
    const add = async (title: string) =>
      only(await alice.request({ type: "create_card", columnId: col, title }), "card_upserted")
        .card;
    const a = await add("A");
    const b = await add("B");
    const x = await add("X");
    await bob.request({ type: "delete_card", cardId: a.id });
    await alice.request({
      type: "move_card",
      cardId: x.id,
      toColumnId: col,
      afterId: a.id,
      beforeId: b.id,
    });

    const snap = only(
      await alice.request({ type: "open_board", boardId: board.id }),
      "board_snapshot",
    );
    expect(
      snap.cards
        .filter((c) => c.columnId === col)
        .sort(comparePositions)
        .map((c) => c.title),
    ).toEqual(["X", "B"]);
  });
});

describe("card presence", () => {
  const cardsOf = (messages: { type: string }[], userId: string) => {
    const latest = messages.filter((m) => m.type === "presence").at(-1) as
      { viewers: { userId: string; cardIds: string[] }[] } | undefined;
    return latest?.viewers.find((v) => v.userId === userId)?.cardIds;
  };

  it("shows which cards each person has open, across their tabs", async () => {
    const { alice, bob, board, columns, card, bobAccount } = await setup();
    const second = only(
      await alice.request({ type: "create_card", columnId: columns[0]!.id, title: "second" }),
      "card_upserted",
    ).card;
    await alice.drain();

    await bob.request({ type: "focus_card", boardId: board.id, cardId: card.id });
    expect(cardsOf(await alice.drain(), bobAccount.user.id)).toEqual([card.id]);

    const bobTab = await connect(bobAccount.cookie);
    await bobTab.request({ type: "open_board", boardId: board.id });
    await bobTab.request({ type: "focus_card", boardId: board.id, cardId: second.id });
    expect(cardsOf(await alice.drain(), bobAccount.user.id)?.sort()).toEqual(
      [card.id, second.id].sort(),
    );

    await bob.request({ type: "focus_card", boardId: board.id, cardId: null });
    expect(cardsOf(await alice.drain(), bobAccount.user.id)).toEqual([second.id]);
  });

  it("ignores focus on a board the socket doesn't have open", async () => {
    const { alice, bob, board, card, bobAccount } = await setup();
    await bob.request({ type: "close_board", boardId: board.id });
    await alice.drain();
    await bob.request({ type: "focus_card", boardId: board.id, cardId: card.id });
    expect(cardsOf(await alice.drain(), bobAccount.user.id)).toBeUndefined();
  });

  it("clears a person's open card when they open another board", async () => {
    const { alice, bob, board, card, bobAccount } = await setup();
    await bob.request({ type: "focus_card", boardId: board.id, cardId: card.id });
    const { board: other } = only(
      await bob.request({ type: "create_board", name: "Elsewhere" }),
      "board_upserted",
    );
    await bob.request({ type: "open_board", boardId: other.id });
    await bob.request({ type: "open_board", boardId: board.id });
    expect(cardsOf(await alice.drain(), bobAccount.user.id)).toEqual([]);
  });
});
