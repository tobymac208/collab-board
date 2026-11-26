// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card } from "@collab/shared";
import { BoardContext, type BoardContextValue } from "./board-context";
import { CardDialog } from "./card-dialog";

beforeAll(() => {
  // jsdom has <dialog> but not its modal API.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

const base: Card = {
  id: "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a",
  boardId: "b",
  columnId: "c",
  title: "Original",
  description: "original notes",
  position: "a0",
  version: 1,
};

function setup(mutate: BoardContextValue["mutate"] = vi.fn(async () => ({ ok: true as const }))) {
  const ctx: BoardContextValue = { mutate, othersOnCard: () => [] };
  const ui = (card: Card) => (
    <BoardContext value={ctx}>
      <CardDialog card={card} onClose={() => {}} />
    </BoardContext>
  );
  const view = render(ui(base));
  return { rerender: (card: Card) => view.rerender(ui(card)), mutate };
}

const title = () => screen.getByLabelText("Title") as HTMLInputElement;
const description = () => screen.getByLabelText("Description") as HTMLTextAreaElement;

describe("CardDialog while someone else edits", () => {
  it("keeps what you typed when someone else saves the same field", () => {
    const { rerender } = setup();
    fireEvent.change(title(), { target: { value: "Mine" } });
    rerender({ ...base, title: "Theirs", version: 2 });
    expect(title().value).toBe("Mine");
  });

  it("shows other people's edits live in fields you haven't touched", () => {
    const { rerender } = setup();
    fireEvent.change(title(), { target: { value: "Mine" } });
    rerender({ ...base, description: "their notes", version: 2 });
    expect(description().value).toBe("their notes");
    expect(title().value).toBe("Mine");
  });

  it("still shows your text next to theirs after a conflict", async () => {
    const mutate = vi.fn(async () => ({
      ok: false as const,
      error: Object.assign(new Error("conflict"), {
        code: "conflict" as const,
        conflictingFields: ["description" as const],
      }),
    }));
    const { rerender } = setup(mutate as unknown as BoardContextValue["mutate"]);
    fireEvent.change(description(), { target: { value: "my notes" } });
    rerender({ ...base, description: "their notes", version: 2 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("their notes");
    expect(description().value).toBe("my notes");
  });
});
