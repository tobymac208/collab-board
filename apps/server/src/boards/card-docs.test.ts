import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyUpdate,
  comparePositions,
  diffSince,
  editText,
  encodeStateVector,
  fromBase64,
  newCardDoc,
  onDocUpdate,
  readText,
  seedUpdate,
  toBase64,
  type CardDoc,
  type ServerEvent,
} from "@collab/shared";
import {
  cookieFrom,
  login,
  only,
  signup,
  startServer,
  useTestDb,
  type TestClient,
  type TestServer,
} from "../test/harness.ts";
import { saveCardText } from "./card-docs.ts";

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

/** Two members viewing one board with one card ("Plan"). */
async function setup() {
  const aliceAccount = await signup(server);
  const bobAccount = await signup(server);
  const alice = await connect(aliceAccount.cookie);
  const bob = await connect(bobAccount.cookie);
  const { board } = only(
    await alice.request({ type: "create_board", name: "Docs" }),
    "board_upserted",
  );
  await alice.request({ type: "add_member", boardId: board.id, email: bobAccount.user.email });
  const snap = only(
    await alice.request({ type: "open_board", boardId: board.id }),
    "board_snapshot",
  );
  await bob.request({ type: "open_board", boardId: board.id });
  const column = [...snap.columns].sort(comparePositions)[0]!;
  const card = only(
    await alice.request({ type: "create_card", columnId: column.id, title: "Plan" }),
    "card_upserted",
  ).card;
  await alice.drain();
  await bob.drain();
  return { alice, bob, board, card, aliceAccount, bobAccount };
}

/** A client-side document synced with the server's copy of a card. */
async function openDoc(client: TestClient, boardId: string, cardId: string) {
  const doc = newCardDoc();
  const sync = only(
    await client.request({
      type: "card_doc_open",
      boardId,
      cardId,
      stateVector: toBase64(encodeStateVector(doc)),
    }),
    "card_doc_sync",
  );
  applyUpdate(doc, fromBase64(sync.update));
  return doc;
}

/** Makes an edit locally and sends it, like the editor does. */
async function edit(
  client: TestClient,
  doc: CardDoc,
  boardId: string,
  cardId: string,
  change: (doc: CardDoc) => void,
) {
  const updates: Uint8Array[] = [];
  const stop = onDocUpdate(doc, (u) => updates.push(u));
  change(doc);
  stop();
  for (const u of updates) {
    await client.request({ type: "card_doc_update", boardId, cardId, update: toBase64(u) });
  }
  return updates;
}

/** Restarts the server with saves that only happen when the test flushes them. */
async function useManualTextSaves() {
  await server.close();
  server = await startServer(getDb(), [], { cardTextSaveDelayMs: 60 * 60 * 1000 });
}

/** Waits for the next message of `type`. */
async function nextOf<T extends ServerEvent["type"]>(client: TestClient, type: T) {
  for (;;) {
    const msg = await client.next();
    if (msg.type === type) return msg as Extract<ServerEvent, { type: T }>;
  }
}

describe("card text documents", () => {
  it("seeds a card's document from its text, the same way every time", async () => {
    const { alice, bob, board, card } = await setup();
    const a = await openDoc(alice, board.id, card.id);
    const b = await openDoc(bob, board.id, card.id);
    expect(readText(a, "title")).toBe("Plan");
    expect(readText(b, "title")).toBe("Plan");
    // A browser seeding the same new card offline makes the identical edit.
    applyUpdate(a, seedUpdate("Plan", ""));
    expect(readText(a, "title")).toBe("Plan");
  });

  it("passes edits to everyone viewing the board, and not back to the sender", async () => {
    const { alice, bob, board, card } = await setup();
    const doc = await openDoc(alice, board.id, card.id);
    const bobDoc = await openDoc(bob, board.id, card.id);
    await edit(alice, doc, board.id, card.id, (d) => editText(d, "description", 0, 0, "Hi"));

    const update = await nextOf(bob, "card_doc_update");
    applyUpdate(bobDoc, fromBase64(update.update));
    expect(readText(bobDoc, "description")).toBe("Hi");
    expect((await alice.drain()).map((m) => m.type)).not.toContain("card_doc_update");
  });

  it("merges concurrent typing at the same spot instead of losing either", async () => {
    const { alice, bob, board, card } = await setup();
    const a = await openDoc(alice, board.id, card.id);
    const b = await openDoc(bob, board.id, card.id);
    // Both type at the end of "Plan" before seeing each other's edit.
    const fromAlice = await edit(alice, a, board.id, card.id, (d) =>
      editText(d, "title", 4, 0, " A"),
    );
    const fromBob = await edit(bob, b, board.id, card.id, (d) => editText(d, "title", 4, 0, " B"));
    for (const u of fromBob) applyUpdate(a, u);
    for (const u of fromAlice) applyUpdate(b, u);

    const server = await openDoc(alice, board.id, card.id);
    expect(readText(server, "title")).toBe(readText(a, "title"));
    expect(readText(a, "title")).toBe(readText(b, "title"));
    expect(readText(a, "title")).toMatch(/^Plan( A B| B A)$/);
  });

  it("refreshes the card's plain text after edits, as a revisioned change", async () => {
    await useManualTextSaves();
    const { alice, bob, board, card } = await setup();
    const doc = await openDoc(alice, board.id, card.id);
    await edit(alice, doc, board.id, card.id, (d) => {
      editText(d, "title", 0, 4, "Roadmap");
      editText(d, "description", 0, 0, "Q1 goals");
    });
    // Both updates are in before the save runs, so one save covers them.
    await server.flushCardText();

    const saved = await nextOf(bob, "card_upserted");
    expect(saved.card).toMatchObject({ title: "Roadmap", description: "Q1 goals" });
    expect(saved.card.version).toBe(card.version + 1);
    const snap = only(
      await bob.request({ type: "open_board", boardId: board.id }),
      "board_snapshot",
    );
    expect(snap.revision).toBe(saved.revision);
    expect(snap.cards.find((c) => c.id === card.id)?.title).toBe("Roadmap");
  });

  it("batches a burst of edits into one plain-text save", async () => {
    await useManualTextSaves();
    const { alice, bob, board, card } = await setup();
    const doc = await openDoc(alice, board.id, card.id);
    for (const ch of " one two") {
      await edit(alice, doc, board.id, card.id, (d) =>
        editText(d, "title", readText(d, "title").length, 0, ch),
      );
    }
    await server.flushCardText();
    await nextOf(bob, "card_upserted");
    expect((await bob.drain()).filter((m) => m.type === "card_upserted")).toHaveLength(0);
  });

  it("retries a failed plain-text save until it works, with the latest text", async () => {
    await server.close();
    let fail = 2;
    server = await startServer(getDb(), [], {
      cardTextSaveDelayMs: 10,
      saveCardText: async (db, cardId) => {
        if (fail-- > 0) throw new Error("database briefly unavailable");
        return saveCardText(db, cardId);
      },
    });
    const { alice, bob, board, card } = await setup();
    const doc = await openDoc(alice, board.id, card.id);
    await edit(alice, doc, board.id, card.id, (d) => editText(d, "title", 0, 4, "Retried"));

    const saved = await nextOf(bob, "card_upserted"); // after two failures
    expect(saved.card.title).toBe("Retried");
    const dirty = await server.db.selectFrom("card_docs").select("dirty").executeTakeFirst();
    expect(dirty?.dirty).toBe(false);
  });

  it("ignores an update it already has", async () => {
    const { alice, bob, board, card } = await setup();
    const doc = await openDoc(alice, board.id, card.id);
    const [update] = await edit(alice, doc, board.id, card.id, (d) =>
      editText(d, "title", 0, 0, "!"),
    );
    await bob.drain();
    await alice.request({
      type: "card_doc_update",
      boardId: board.id,
      cardId: card.id,
      update: toBase64(update!),
    });
    expect((await bob.drain()).map((m) => m.type)).not.toContain("card_doc_update");
  });

  it("sends a reconnecting client only what it's missing", async () => {
    const { alice, bob, board, card } = await setup();
    const bobDoc = await openDoc(bob, board.id, card.id);
    const doc = await openDoc(alice, board.id, card.id);
    await edit(alice, doc, board.id, card.id, (d) => editText(d, "description", 0, 0, "new"));
    const sync = only(
      await bob.request({
        type: "card_doc_open",
        boardId: board.id,
        cardId: card.id,
        stateVector: toBase64(encodeStateVector(bobDoc)),
      }),
      "card_doc_sync",
    );
    applyUpdate(bobDoc, fromBase64(sync.update));
    expect(readText(bobDoc, "description")).toBe("new");
    // And bob can work out what the server is missing from its state vector.
    expect(diffSince(bobDoc, fromBase64(sync.stateVector)).length).toBeLessThan(10);
  });

  it("refuses people who aren't on the board, and cards from another board", async () => {
    const { alice, board, card, aliceAccount } = await setup();
    const outsider = await connect((await signup(server)).cookie);
    await expect(openDoc(outsider, board.id, card.id)).rejects.toMatchObject({ code: "not_found" });
    const other = await connect(aliceAccount.cookie);
    const { board: elsewhere } = only(
      await other.request({ type: "create_board", name: "Elsewhere" }),
      "board_upserted",
    );
    await expect(openDoc(alice, elsewhere.id, card.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects a document that would grow too large", async () => {
    const { alice, board, card } = await setup();
    const doc = await openDoc(alice, board.id, card.id);
    await expect(
      edit(alice, doc, board.id, card.id, (d) =>
        editText(d, "description", 0, 0, "x".repeat(270_000)),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("passes cursors on to other viewers without storing them", async () => {
    const { alice, bob, board, card } = await setup();
    await alice.request({
      type: "card_awareness",
      boardId: board.id,
      cardId: card.id,
      update: "AQID",
    });
    expect(await nextOf(bob, "card_awareness")).toMatchObject({ cardId: card.id, update: "AQID" });
    const outsider = await connect((await signup(server)).cookie);
    await expect(
      outsider.request({
        type: "card_awareness",
        boardId: board.id,
        cardId: card.id,
        update: "AQID",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("saves text that was still waiting when the server stopped", async () => {
    const { board, card, aliceAccount } = await setup();
    // A server whose save never fires before it stops (like a crash).
    await server.close();
    server = await startServer(getDb(), [], { cardTextSaveDelayMs: 60_000 });
    const before = await connect(await loginCookie(aliceAccount.user.email));
    const doc = await openDoc(before, board.id, card.id);
    await edit(before, doc, board.id, card.id, (d) => editText(d, "title", 0, 4, "Survived"));
    await server.close();

    // The next server finds the leftover and saves it on startup.
    server = await startServer(getDb());
    const after = await connect(await loginCookie(aliceAccount.user.email));
    for (let i = 0; i < 50; i++) {
      const snap = only(
        await after.request({ type: "open_board", boardId: board.id }),
        "board_snapshot",
      );
      if (snap.cards.find((c) => c.id === card.id)?.title === "Survived") return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the leftover text was never saved");
  });
});

async function loginCookie(email: string): Promise<string> {
  const res = await fetch(`http://${server.base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  return cookieFrom(res);
}
