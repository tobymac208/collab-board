import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@collab/shared";
import { CLOSE_SESSION_ENDED } from "../server.ts";
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

/** A logged-in client, closed automatically after the test. */
async function connect(cookie: string): Promise<TestClient> {
  const client = await login(server, cookie);
  clients.push(client);
  return client;
}

/** A fresh user with one connection. */
async function newUser(email?: string) {
  const account = await signup(server, email ? { email } : {});
  return { ...account, client: await connect(account.cookie) };
}

/** An owner with a board, plus an editor who is a member of it. */
async function sharedBoard() {
  const owner = await newUser();
  const editor = await newUser();
  const { board } = only(
    await owner.client.request({ type: "create_board", name: "Shared" }),
    "board_upserted",
  );
  await owner.client.request({ type: "add_member", boardId: board.id, email: editor.user.email });
  return { owner, editor, board };
}

async function open(client: TestClient, boardId: string) {
  return only(await client.request({ type: "open_board", boardId }), "board_snapshot");
}

const types = (messages: ServerMessage[]) => messages.map((m) => m.type);
const withoutPresence = (messages: ServerMessage[]) =>
  messages.filter((m) => m.type !== "presence");

describe("broadcasting board changes", () => {
  it("sends each change to other viewers, and only once to the requester", async () => {
    const { owner, editor, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    await open(editor.client, board.id);
    await owner.client.drain();
    await editor.client.drain();

    const todo = snap.columns[0]!;
    const reply = only(
      await owner.client.request({ type: "create_card", columnId: todo.id, title: "hello" }),
      "card_upserted",
    );
    expect(reply.requestId).toBeDefined();

    const seen = withoutPresence(await editor.client.drain());
    expect(seen).toEqual([{ type: "card_upserted", card: reply.card, revision: reply.revision }]);
    // The requester got its reply and nothing else.
    expect(withoutPresence(await owner.client.drain())).toEqual([]);
  });

  it("covers moves, edits and deletes, each with the next revision", async () => {
    const { owner, editor, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    await open(editor.client, board.id);
    await editor.client.drain();
    const [todo, doing] = snap.columns;
    const card = only(
      await owner.client.request({ type: "create_card", columnId: todo!.id, title: "a" }),
      "card_upserted",
    ).card;
    await owner.client.request({
      type: "move_card",
      cardId: card.id,
      toColumnId: doing!.id,
      toIndex: 0,
    });
    await owner.client.request({ type: "update_card", cardId: card.id, title: "b" });
    await owner.client.request({ type: "rename_column", columnId: todo!.id, name: "Backlog" });
    await owner.client.request({ type: "delete_card", cardId: card.id });
    await owner.client.request({ type: "delete_column", columnId: todo!.id });

    const seen = withoutPresence(await editor.client.drain());
    expect(types(seen)).toEqual([
      "card_upserted",
      "card_upserted",
      "card_upserted",
      "column_upserted",
      "card_deleted",
      "column_deleted",
    ]);
    const revisions = seen.map((m) => ("revision" in m ? m.revision : -1));
    expect(revisions).toEqual(revisions.map((_, i) => snap.revision + 1 + i));
  });

  it("does not send board changes to members who don't have the board open", async () => {
    const { owner, editor, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    await editor.client.drain();
    await owner.client.request({ type: "create_card", columnId: snap.columns[0]!.id, title: "x" });
    expect(await editor.client.drain()).toEqual([]);
  });

  it("stops sending changes after close_board", async () => {
    const { owner, editor, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    await open(editor.client, board.id);
    await editor.client.request({ type: "close_board", boardId: board.id });
    await editor.client.drain();
    await owner.client.request({ type: "create_card", columnId: snap.columns[0]!.id, title: "x" });
    expect(await editor.client.drain()).toEqual([]);
  });

  it("never subscribes someone who isn't a member", async () => {
    const { owner, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    const outsider = await newUser();
    await expect(open(outsider.client, board.id)).rejects.toMatchObject({ code: "not_found" });
    await owner.client.request({ type: "create_card", columnId: snap.columns[0]!.id, title: "x" });
    expect(await outsider.client.drain()).toEqual([]);
  });

  it("delivers the requester's own change to its other tabs", async () => {
    const { owner, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    const otherTab = await connect(owner.cookie);
    await open(otherTab, board.id);
    await otherTab.drain();
    await owner.client.request({ type: "create_card", columnId: snap.columns[0]!.id, title: "x" });
    expect(types(withoutPresence(await otherTab.drain()))).toEqual(["card_upserted"]);
  });
});

describe("board list updates", () => {
  it("tells every member about a rename, each with their own role", async () => {
    const { owner, editor, board } = await sharedBoard();
    const ownerTab = await connect(owner.cookie);
    await editor.client.drain();
    await owner.client.request({ type: "rename_board", boardId: board.id, name: "Renamed" });

    expect(await editor.client.drain()).toMatchObject([
      { type: "board_upserted", board: { id: board.id, name: "Renamed", role: "editor" } },
    ]);
    expect(await ownerTab.drain()).toMatchObject([
      { type: "board_upserted", board: { name: "Renamed", role: "owner" } },
    ]);
  });

  it("shows a board to someone the moment they're added, and tells viewers", async () => {
    const owner = await newUser();
    const { board } = only(
      await owner.client.request({ type: "create_board", name: "Party" }),
      "board_upserted",
    );
    const watcher = await connect(owner.cookie);
    await open(watcher, board.id);
    await watcher.drain();
    const newcomer = await newUser("newcomer@example.com");

    await owner.client.request({
      type: "add_member",
      boardId: board.id,
      email: "newcomer@example.com",
    });
    expect(await newcomer.client.drain()).toMatchObject([
      { type: "board_upserted", board: { id: board.id, name: "Party", role: "editor" } },
    ]);
    expect(withoutPresence(await watcher.drain())).toMatchObject([
      { type: "member_added", member: { email: "newcomer@example.com", role: "editor" } },
    ]);
  });

  it("tells members and viewers when a board is deleted", async () => {
    const { owner, editor, board } = await sharedBoard();
    const editorTab = await connect(editor.cookie);
    await open(editor.client, board.id);
    await editor.client.drain();
    await editorTab.drain();

    await owner.client.request({ type: "delete_board", boardId: board.id });
    const deleted = { type: "board_deleted", boardId: board.id };
    expect(withoutPresence(await editor.client.drain())).toEqual([deleted]);
    expect(await editorTab.drain()).toEqual([deleted]);
  });

  it("shows a new board in the creator's other tabs", async () => {
    const owner = await newUser();
    const otherTab = await connect(owner.cookie);
    await owner.client.request({ type: "create_board", name: "Fresh" });
    expect(await otherTab.drain()).toMatchObject([
      { type: "board_upserted", board: { name: "Fresh", role: "owner" } },
    ]);
  });
});

describe("presence", () => {
  const names = (messages: ServerMessage[]) => {
    const latest = messages.filter((m) => m.type === "presence").at(-1);
    return latest?.type === "presence" ? latest.viewers.map((v) => v.displayName).sort() : null;
  };

  it("tracks who has a board open, once per person", async () => {
    const { owner, editor, board } = await sharedBoard();
    await open(owner.client, board.id);
    expect(names(await owner.client.drain())).toEqual([owner.user.displayName]);

    await open(editor.client, board.id);
    const both = [owner.user.displayName, editor.user.displayName].sort();
    expect(names(await owner.client.drain())).toEqual(both);
    expect(names(await editor.client.drain())).toEqual(both);

    // A second tab doesn't add a second entry.
    const editorTab = await connect(editor.cookie);
    await open(editorTab, board.id);
    expect(names(await owner.client.drain())).toEqual(both);

    // Closing one of two tabs keeps them present; closing the last removes them.
    editorTab.close();
    await new Promise((resolve) => editorTab.ws.once("close", resolve));
    expect(names(await owner.client.drain())).toEqual(both);
    await editor.client.request({ type: "close_board", boardId: board.id });
    expect(names(await owner.client.drain())).toEqual([owner.user.displayName]);
  });

  it("removes people when they disconnect", async () => {
    const { owner, editor, board } = await sharedBoard();
    await open(owner.client, board.id);
    await open(editor.client, board.id);
    await owner.client.drain();
    editor.client.close();
    // The server notices the close asynchronously; wait for the update.
    for (;;) {
      const msg = await owner.client.next();
      if (msg.type === "presence") {
        expect(msg.viewers.map((v) => v.userId)).toEqual([owner.user.id]);
        break;
      }
    }
  });

  it("moves people between boards when they open another one", async () => {
    const { owner, editor, board } = await sharedBoard();
    const { board: other } = only(
      await editor.client.request({ type: "create_board", name: "Elsewhere" }),
      "board_upserted",
    );
    await open(owner.client, board.id);
    await open(editor.client, board.id);
    await owner.client.drain();
    await open(editor.client, other.id);
    expect(names(await owner.client.drain())).toEqual([owner.user.displayName]);
  });
});

describe("session expiry", () => {
  it("disconnects idle sockets whose session ended, and stops broadcasting to them", async () => {
    await server.close();
    server = await startServer(getDb(), [], { sessionCheckIntervalMs: 50 });
    const { owner, editor, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    await open(editor.client, board.id);
    await editor.client.drain();

    // Record everything the editor receives from here on, without sending anything.
    const received: string[] = [];
    editor.client.ws.on("message", (data) => received.push(JSON.parse(data.toString()).type));
    const closed = new Promise<number>((resolve) => editor.client.ws.on("close", resolve));

    await server.db
      .updateTable("sessions")
      .set({ expires_at: new Date(0) })
      .where("user_id", "=", editor.user.id)
      .execute();
    expect(await closed).toBe(CLOSE_SESSION_ENDED);

    await owner.client.request({ type: "create_card", columnId: snap.columns[0]!.id, title: "x" });
    expect(received.filter((t) => t !== "presence")).toEqual([]);
    // The owner's session is fine: still connected, and the editor has left.
    const presence = (await owner.client.drain()).filter((m) => m.type === "presence").at(-1);
    expect(presence).toMatchObject({ viewers: [{ userId: owner.user.id }] });
  });
});

describe("revisions", () => {
  it("assigns gap-free, unique revisions to concurrent writes from many sockets", async () => {
    const { owner, board } = await sharedBoard();
    const snap = await open(owner.client, board.id);
    const sockets = await Promise.all(Array.from({ length: 5 }, () => connect(owner.cookie)));
    const replies = await Promise.all(
      sockets.flatMap((socket, i) =>
        Array.from({ length: 4 }, (_, j) =>
          socket.request({
            type: "create_card",
            columnId: snap.columns[(i + j) % 3]!.id,
            title: `${i}-${j}`,
          }),
        ),
      ),
    );
    const revisions = replies
      .map((events) => only(events, "card_upserted").revision)
      .sort((a, b) => a - b);
    expect(revisions).toEqual(revisions.map((_, i) => snap.revision + 1 + i));
    expect((await open(owner.client, board.id)).revision).toBe(snap.revision + revisions.length);
  });

  it("doesn't consume a revision when a write fails", async () => {
    const { owner, editor, board } = await sharedBoard();
    const before = (await open(owner.client, board.id)).revision;
    await expect(
      editor.client.request({ type: "rename_board", boardId: board.id, name: "nope" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      owner.client.request({ type: "add_member", boardId: board.id, email: editor.user.email }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await open(owner.client, board.id)).revision).toBe(before);
  });
});
