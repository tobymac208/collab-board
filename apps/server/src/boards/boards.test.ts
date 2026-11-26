import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card, Column } from "@collab/shared";
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
import { positionAt } from "./store.ts";

const getDb = useTestDb();
let server: TestServer;
let alice: TestClient;

beforeEach(async () => {
  server = await startServer(getDb());
  alice = await login(server, (await signup(server)).cookie);
});

afterEach(async () => {
  alice.close();
  await server.close();
});

async function createBoard(client: TestClient, name = "Roadmap") {
  return only(await client.request({ type: "create_board", name }), "board_upserted").board;
}

async function snapshot(client: TestClient, boardId: string) {
  return only(await client.request({ type: "open_board", boardId }), "board_snapshot");
}

async function addCard(client: TestClient, columnId: string, title: string): Promise<Card> {
  return only(await client.request({ type: "create_card", columnId, title }), "card_upserted").card;
}

/** Card titles per column, in display order. */
async function layout(client: TestClient, boardId: string): Promise<Record<string, string[]>> {
  const snap = await snapshot(client, boardId);
  const result: Record<string, string[]> = {};
  for (const column of [...snap.columns].sort(comparePositions)) {
    result[column.name] = snap.cards
      .filter((c) => c.columnId === column.id)
      .sort(comparePositions)
      .map((c) => c.title);
  }
  return result;
}

const columnNamed = (columns: Column[], name: string) => columns.find((c) => c.name === name)!;

describe("positionAt", () => {
  it("produces keys that sort at the requested index", () => {
    const keys = ["a0", "a1", "a2"];
    for (let i = 0; i <= keys.length; i++) {
      const key = positionAt(keys, i);
      const sorted = [...keys, key].sort();
      expect(sorted.indexOf(key)).toBe(i);
    }
  });

  it("clamps indexes past the end", () => {
    expect(positionAt(["a0"], 99) > "a0").toBe(true);
  });
});

describe("boards", () => {
  it("creates a board with default columns, owned by its creator", async () => {
    const board = await createBoard(alice, "Launch");
    expect(board).toMatchObject({ name: "Launch", role: "owner" });

    const snap = await snapshot(alice, board.id);
    expect(snap.columns.sort(comparePositions).map((c) => c.name)).toEqual([
      "To do",
      "In progress",
      "Done",
    ]);
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0]).toMatchObject({ role: "owner" });
  });

  it("lists only boards the user belongs to", async () => {
    await createBoard(alice, "Mine");
    const bob = await login(server, (await signup(server)).cookie);
    await createBoard(bob, "Bob's");
    const list = only(await alice.request({ type: "list_boards" }), "board_list");
    expect(list.boards.map((b) => b.name)).toEqual(["Mine"]);
    bob.close();
  });

  it("renames and deletes", async () => {
    const board = await createBoard(alice);
    const renamed = only(
      await alice.request({ type: "rename_board", boardId: board.id, name: "Renamed" }),
      "board_upserted",
    );
    expect(renamed.board.name).toBe("Renamed");

    await alice.request({ type: "delete_board", boardId: board.id });
    await expect(snapshot(alice, board.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("membership and access", () => {
  it("hides boards from non-members", async () => {
    const board = await createBoard(alice);
    const { columns } = await snapshot(alice, board.id);
    const card = await addCard(alice, columns[0]!.id, "secret");

    const mallory = await login(server, (await signup(server)).cookie);
    const attempts = [
      mallory.request({ type: "open_board", boardId: board.id }),
      mallory.request({ type: "rename_board", boardId: board.id, name: "pwned" }),
      mallory.request({ type: "create_card", columnId: columns[0]!.id, title: "x" }),
      mallory.request({ type: "update_card", cardId: card.id, title: "x" }),
      mallory.request({ type: "delete_card", cardId: card.id }),
      mallory.request({ type: "delete_column", columnId: columns[0]!.id }),
      mallory.request({
        type: "move_card",
        cardId: card.id,
        toColumnId: columns[1]!.id,
        toIndex: 0,
      }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await layout(alice, board.id)).toMatchObject({ "To do": ["secret"] });
    mallory.close();
  });

  it("lets the owner add editors, who can edit cards but not manage the board", async () => {
    const board = await createBoard(alice);
    const bobAccount = await signup(server, { email: "bob@example.com" });
    const bob = await login(server, bobAccount.cookie);

    const added = only(
      await alice.request({ type: "add_member", boardId: board.id, email: "BOB@example.com" }),
      "member_added",
    );
    expect(added.member).toMatchObject({ userId: bobAccount.user.id, role: "editor" });

    const { columns } = await snapshot(bob, board.id);
    await addCard(bob, columns[0]!.id, "from bob");
    expect(await layout(alice, board.id)).toMatchObject({ "To do": ["from bob"] });

    await expect(
      bob.request({ type: "rename_board", boardId: board.id, name: "mine now" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(bob.request({ type: "delete_board", boardId: board.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    bob.close();
  });

  it("reports unknown emails and duplicate members", async () => {
    const board = await createBoard(alice);
    await expect(
      alice.request({ type: "add_member", boardId: board.id, email: "ghost@example.com" }),
    ).rejects.toMatchObject({ code: "not_found" });

    await signup(server, { email: "carol@example.com" });
    await alice.request({ type: "add_member", boardId: board.id, email: "carol@example.com" });
    await expect(
      alice.request({ type: "add_member", boardId: board.id, email: "carol@example.com" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("columns", () => {
  it("appends new columns and reorders them", async () => {
    const board = await createBoard(alice);
    const review = only(
      await alice.request({ type: "create_column", boardId: board.id, name: "Review" }),
      "column_upserted",
    ).column;

    const order = async () =>
      (await snapshot(alice, board.id)).columns.sort(comparePositions).map((c) => c.name);
    expect(await order()).toEqual(["To do", "In progress", "Done", "Review"]);

    await alice.request({ type: "move_column", columnId: review.id, toIndex: 0 });
    expect(await order()).toEqual(["Review", "To do", "In progress", "Done"]);

    await alice.request({ type: "move_column", columnId: review.id, toIndex: 2 });
    expect(await order()).toEqual(["To do", "In progress", "Review", "Done"]);
  });

  it("renames, and deleting a column deletes its cards", async () => {
    const board = await createBoard(alice);
    const { columns } = await snapshot(alice, board.id);
    const todo = columnNamed(columns, "To do");
    await addCard(alice, todo.id, "doomed");

    const renamed = only(
      await alice.request({ type: "rename_column", columnId: todo.id, name: "Backlog" }),
      "column_upserted",
    );
    expect(renamed.column.name).toBe("Backlog");

    const deleted = only(
      await alice.request({ type: "delete_column", columnId: todo.id }),
      "column_deleted",
    );
    expect(deleted).toMatchObject({ boardId: board.id, columnId: todo.id });
    const snap = await snapshot(alice, board.id);
    expect(snap.columns).toHaveLength(2);
    expect(snap.cards).toHaveLength(0);
  });
});

describe("cards", () => {
  it("appends cards to the end of a column", async () => {
    const board = await createBoard(alice);
    const todo = columnNamed((await snapshot(alice, board.id)).columns, "To do");
    for (const title of ["a", "b", "c"]) await addCard(alice, todo.id, title);
    expect(await layout(alice, board.id)).toMatchObject({ "To do": ["a", "b", "c"] });
  });

  it("updates title and description independently", async () => {
    const board = await createBoard(alice);
    const todo = columnNamed((await snapshot(alice, board.id)).columns, "To do");
    const card = await addCard(alice, todo.id, "draft");

    const withDescription = only(
      await alice.request({ type: "update_card", cardId: card.id, description: "details" }),
      "card_upserted",
    ).card;
    expect(withDescription).toMatchObject({ title: "draft", description: "details" });

    const retitled = only(
      await alice.request({ type: "update_card", cardId: card.id, title: "final" }),
      "card_upserted",
    ).card;
    expect(retitled).toMatchObject({ title: "final", description: "details" });
  });

  it("moves cards within and across columns", async () => {
    const board = await createBoard(alice);
    const { columns } = await snapshot(alice, board.id);
    const todo = columnNamed(columns, "To do");
    const doing = columnNamed(columns, "In progress");
    const [a, , c] = [
      await addCard(alice, todo.id, "a"),
      await addCard(alice, todo.id, "b"),
      await addCard(alice, todo.id, "c"),
    ];

    await alice.request({ type: "move_card", cardId: c!.id, toColumnId: todo.id, toIndex: 0 });
    expect(await layout(alice, board.id)).toMatchObject({ "To do": ["c", "a", "b"] });

    await alice.request({ type: "move_card", cardId: a!.id, toColumnId: todo.id, toIndex: 2 });
    expect(await layout(alice, board.id)).toMatchObject({ "To do": ["c", "b", "a"] });

    await alice.request({ type: "move_card", cardId: c!.id, toColumnId: doing.id, toIndex: 0 });
    await alice.request({ type: "move_card", cardId: a!.id, toColumnId: doing.id, toIndex: 0 });
    expect(await layout(alice, board.id)).toMatchObject({
      "To do": ["b"],
      "In progress": ["a", "c"],
    });
  });

  it("refuses to move a card onto another board", async () => {
    const one = await createBoard(alice, "one");
    const two = await createBoard(alice, "two");
    const [colOne] = (await snapshot(alice, one.id)).columns;
    const [colTwo] = (await snapshot(alice, two.id)).columns;
    const card = await addCard(alice, colOne!.id, "stay");
    await expect(
      alice.request({ type: "move_card", cardId: card.id, toColumnId: colTwo!.id, toIndex: 0 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps positions unique when two users insert into the same column at once", async () => {
    const board = await createBoard(alice);
    const bobAccount = await signup(server, { email: "racer@example.com" });
    await alice.request({ type: "add_member", boardId: board.id, email: "racer@example.com" });
    const bob = await login(server, bobAccount.cookie);
    const todo = columnNamed((await snapshot(alice, board.id)).columns, "To do");

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => addCard(i % 2 ? alice : bob, todo.id, `card ${i}`)),
    );
    const { cards } = await snapshot(alice, board.id);
    expect(cards).toHaveLength(10);
    expect(new Set(cards.map((c) => c.position)).size).toBe(10);
    bob.close();
  });

  it("deletes cards", async () => {
    const board = await createBoard(alice);
    const todo = columnNamed((await snapshot(alice, board.id)).columns, "To do");
    const card = await addCard(alice, todo.id, "gone");
    const deleted = only(
      await alice.request({ type: "delete_card", cardId: card.id }),
      "card_deleted",
    );
    expect(deleted).toMatchObject({ type: "card_deleted", boardId: board.id, cardId: card.id });
    expect((await snapshot(alice, board.id)).cards).toHaveLength(0);
  });
});
