import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUpdate,
  diffSince,
  editText,
  encodeStateVector,
  fromBase64,
  newCardDoc,
  readText,
  seedUpdate,
  toBase64,
  type CardDoc,
  type ClientRequestBody,
  type ServerEvent,
} from "@collab/shared";
import { CardDocs, LOCAL } from "./card-docs.ts";

const BOARD = "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a";
const CARD = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";

/** A stand-in server: one document per card, relaying updates to other clients. */
class FakeServer {
  docs = new Map<string, CardDoc>();
  clients = new Set<CardDocs>();
  online = new Map<CardDocs, boolean>();
  sent: ClientRequestBody[] = [];

  doc(cardId: string) {
    let doc = this.docs.get(cardId);
    if (!doc) {
      doc = newCardDoc();
      applyUpdate(doc, seedUpdate("Plan", ""));
      this.docs.set(cardId, doc);
    }
    return doc;
  }

  connect(onError = () => {}) {
    const client: CardDocs = new CardDocs(
      BOARD,
      async (body) => {
        if (!this.online.get(client)) {
          throw Object.assign(new Error("offline"), { code: "disconnected" });
        }
        this.sent.push(body);
        if (body.type === "card_doc_open") {
          const doc = this.doc(body.cardId);
          return [
            {
              type: "card_doc_sync",
              boardId: BOARD,
              cardId: body.cardId,
              update: toBase64(diffSince(doc, fromBase64(body.stateVector))),
              stateVector: toBase64(encodeStateVector(doc)),
            },
          ];
        }
        if (body.type === "card_doc_update" || body.type === "card_awareness") {
          if (body.type === "card_doc_update")
            applyUpdate(this.doc(body.cardId), fromBase64(body.update));
          for (const other of this.clients) {
            if (other !== client && this.online.get(other))
              other.handle({ ...body } as ServerEvent);
          }
        }
        return [];
      },
      onError,
    );
    this.clients.add(client);
    this.setOnline(client, true);
    return client;
  }

  setOnline(client: CardDocs, online: boolean) {
    this.online.set(client, online);
    client.setLive(online);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Lets queued promises and batching timers run. */
const settle = async () => {
  // Advance by a fixed amount: cursor tracking keeps a repeating timer, so
  // "run all timers" would never finish.
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(200);
};
const type = (docs: CardDocs, text: string, at = 0) =>
  editText(docs.get(CARD)!.doc, "description", at, 0, text, LOCAL);
const text = (docs: CardDocs) => readText(docs.get(CARD)!.doc, "description");

describe("CardDocs", () => {
  it("syncs a card on open and shares edits live", async () => {
    const server = new FakeServer();
    const alice = server.connect();
    const bob = server.connect();
    alice.open(CARD);
    bob.open(CARD);
    await settle();
    expect(readText(alice.get(CARD)!.doc, "title")).toBe("Plan");

    type(alice, "hello");
    await settle();
    expect(text(bob)).toBe("hello");
    expect(readText(server.doc(CARD), "description")).toBe("hello");
    expect(alice.get(CARD)!.dirty).toBe(false);
  });

  it("batches keystrokes into one update", async () => {
    const server = new FakeServer();
    const alice = server.connect();
    alice.open(CARD);
    await settle();
    server.sent = [];
    for (const ch of "abc") type(alice, ch, text(alice).length);
    await settle();
    expect(server.sent.filter((m) => m.type === "card_doc_update")).toHaveLength(1);
  });

  it("keeps offline edits and merges them on reconnect, with others' edits", async () => {
    const server = new FakeServer();
    const alice = server.connect();
    const bob = server.connect();
    alice.open(CARD);
    bob.open(CARD);
    await settle();

    server.setOnline(alice, false);
    type(alice, "alice offline ");
    expect(alice.get(CARD)!.dirty).toBe(true);
    expect(alice.dirtyCount()).toBe(1);
    type(bob, "bob online");
    await settle();

    server.setOnline(alice, true);
    await settle();
    expect(text(alice)).toBe(text(bob));
    expect(text(alice)).toContain("alice offline");
    expect(text(alice)).toContain("bob online");
    expect(alice.get(CARD)!.dirty).toBe(false);
  });

  it("can't open a card offline that it never had, unless it may seed it", async () => {
    const server = new FakeServer();
    const alice = server.connect();
    server.setOnline(alice, false);
    expect(alice.open(CARD)).toBeUndefined();
    // A card still showing its creation text can be seeded locally...
    const entry = alice.open(CARD, { title: "Plan", description: "" })!;
    type(alice, "offline");
    server.setOnline(alice, true);
    await settle();
    // ...and the two seeds merge into one title, not "PlanPlan".
    expect(readText(entry.doc, "title")).toBe("Plan");
    expect(readText(server.doc(CARD), "description")).toBe("offline");
  });

  it("survives a reload through what it saves", async () => {
    const server = new FakeServer();
    const alice = server.connect();
    alice.open(CARD);
    await settle();
    server.setOnline(alice, false);
    type(alice, "unsent");
    const saved = alice.export();
    expect(saved[CARD]?.dirty).toBe(true);

    const reloaded = server.connect();
    server.setOnline(reloaded, false);
    reloaded.import(saved);
    expect(text(reloaded)).toBe("unsent");
    server.setOnline(reloaded, true);
    await settle();
    expect(readText(server.doc(CARD), "description")).toBe("unsent");
    expect(reloaded.get(CARD)!.dirty).toBe(false);
  });

  it("passes cursors between clients", async () => {
    const server = new FakeServer();
    const alice = server.connect();
    const bob = server.connect();
    alice.open(CARD);
    bob.open(CARD);
    await settle();
    alice.get(CARD)!.awareness.setLocalState({ user: { name: "Alice" } });
    await settle();
    const states = [...bob.get(CARD)!.awareness.getStates().values()];
    expect(states).toContainEqual(expect.objectContaining({ user: { name: "Alice" } }));
  });

  it("reports errors other than disconnects", async () => {
    const onError = vi.fn();
    const server = new FakeServer();
    const alice = server.connect(onError);
    alice.open(CARD);
    await settle();
    const realDoc = server.doc.bind(server);
    server.doc = () => {
      throw Object.assign(new Error("this card's text is too long to save"), { code: "conflict" });
    };
    type(alice, "x");
    await settle();
    expect(onError).toHaveBeenCalledWith("this card's text is too long to save");
    server.doc = realDoc;
  });
});
