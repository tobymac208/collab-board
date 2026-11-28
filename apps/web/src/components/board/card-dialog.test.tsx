// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyUpdate,
  cursorAt,
  diffSince,
  editText,
  encodeStateVector,
  fromBase64,
  newCardDoc,
  readText,
  seedUpdate,
  toBase64,
  type Card,
  type CardDoc,
  type ServerEvent,
} from "@collab/shared";
import { CardDocs, LOCAL } from "@/lib/card-docs";
import { BoardContext, type BoardContextValue } from "./board-context";
import { CardDialog } from "./card-dialog";
import { diffText } from "./crdt-field";

beforeAll(() => {
  // jsdom has <dialog> but not its modal API, nor ResizeObserver.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const BOARD = "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a";
const card: Card = {
  id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
  boardId: BOARD,
  columnId: "c",
  title: "Plan",
  description: "",
  position: "a0",
  version: 3,
};

/** Two browsers sharing one card through a stand-in server. */
function twoBrowsers() {
  const serverDoc: CardDoc = newCardDoc();
  applyUpdate(serverDoc, seedUpdate("Plan", ""));
  const all: CardDocs[] = [];
  const connect = () => {
    const docs: CardDocs = new CardDocs(
      BOARD,
      async (body) => {
        if (body.type === "card_doc_open") {
          return [
            {
              type: "card_doc_sync",
              boardId: BOARD,
              cardId: body.cardId,
              update: toBase64(diffSince(serverDoc, fromBase64(body.stateVector))),
              stateVector: toBase64(encodeStateVector(serverDoc)),
            },
          ];
        }
        if (body.type === "card_doc_update") applyUpdate(serverDoc, fromBase64(body.update));
        if (body.type === "card_doc_update" || body.type === "card_awareness") {
          for (const other of all) if (other !== docs) other.handle({ ...body } as ServerEvent);
        }
        return [];
      },
      () => {},
    );
    docs.setLive(true);
    all.push(docs);
    return docs;
  };
  return { mine: connect(), theirs: connect(), serverDoc };
}

function renderEditor(cardDocs: CardDocs, live = true) {
  const ctx: BoardContextValue = {
    mutate: vi.fn(async () => ({ ok: true as const })),
    othersOnCard: () => [],
    cardDocs,
    live,
    me: { name: "Me", color: "red" },
  };
  return render(
    <BoardContext value={ctx}>
      <CardDialog card={card} onClose={() => {}} />
    </BoardContext>,
  );
}

const title = () => screen.getByLabelText("Title") as HTMLInputElement;

/** Opens the card in the other browser and waits until it has synced. */
async function openTheirs(theirs: CardDocs) {
  theirs.open(card.id);
  await waitFor(() => expect(theirs.get(card.id)?.synced).toBe(true));
  return theirs.get(card.id)!;
}

describe("diffText", () => {
  it("finds the single edit between two strings", () => {
    expect(diffText("hello", "help")).toEqual({ index: 3, deleteCount: 2, insert: "p" });
    expect(diffText("abc", "abXc")).toEqual({ index: 2, deleteCount: 0, insert: "X" });
    expect(diffText("aaa", "aa")).toEqual({ index: 2, deleteCount: 1, insert: "" });
    expect(diffText("", "new")).toEqual({ index: 0, deleteCount: 0, insert: "new" });
  });
});

describe("live card editor", () => {
  it("edits the card's shared document as you type", async () => {
    const { mine, serverDoc } = twoBrowsers();
    renderEditor(mine);
    await waitFor(() => expect(title().value).toBe("Plan"));
    fireEvent.change(title(), { target: { value: "Plan B" } });
    await waitFor(() => expect(readText(serverDoc, "title")).toBe("Plan B"));
  });

  it("shows someone else's typing live and keeps your cursor where it was", async () => {
    const { mine, theirs } = twoBrowsers();
    renderEditor(mine);
    await waitFor(() => expect(title().value).toBe("Plan"));
    const other = await openTheirs(theirs);

    title().focus();
    title().setSelectionRange(2, 2); // "Pl|an"
    fireEvent.select(title());
    act(() => editText(other.doc, "title", 0, 0, ">> ", LOCAL)); // typed in their browser
    await waitFor(() => expect(title().value).toBe(">> Plan"));
    expect(title().selectionStart).toBe(5); // still "Pl|an"
  });

  it("undoes only your own typing", async () => {
    const { mine, theirs } = twoBrowsers();
    renderEditor(mine);
    await waitFor(() => expect(title().value).toBe("Plan"));
    fireEvent.change(title(), { target: { value: "Plan mine" } });
    const other = await openTheirs(theirs);
    await waitFor(() => expect(readText(other.doc, "title")).toBe("Plan mine"));
    act(() => editText(other.doc, "title", 0, 0, "theirs ", LOCAL));
    await waitFor(() => expect(title().value).toBe("theirs Plan mine"));

    fireEvent.keyDown(title(), { key: "z", ctrlKey: true });
    await waitFor(() => expect(title().value).toBe("theirs Plan"));
  });

  it("is read-only offline for a card whose text was never opened here", () => {
    const docs = new CardDocs(
      BOARD,
      async () => [],
      () => {},
    );
    renderEditor(docs, false);
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.getByText(/once you reconnect/)).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  it("shows other people's cursors with their names", async () => {
    const { mine, theirs } = twoBrowsers();
    renderEditor(mine);
    await waitFor(() => expect(title().value).toBe("Plan"));
    const other = await openTheirs(theirs);
    act(() => {
      other.awareness.setLocalState({
        user: { name: "Bob", color: "blue" },
        cursor: {
          field: "title",
          anchor: cursorAt(other.doc, "title", 2),
          head: cursorAt(other.doc, "title", 2),
        },
      });
    });
    await waitFor(() => expect(screen.getByText("Bob")).toBeTruthy());
  });
});
