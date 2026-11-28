// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useConfirm, type ConfirmOptions } from "./ui";

beforeAll(() => {
  // jsdom has <dialog> but not its modal API; close() must fire "close" like browsers do.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(cleanup);

const options: ConfirmOptions = {
  title: "Delete column?",
  message: "To do will be deleted.",
  confirmLabel: "Delete column",
  danger: true,
};

/** Renders a component using the hook and exposes its `confirm`. */
function setup() {
  let confirm!: (o: ConfirmOptions) => Promise<boolean>;
  function Harness() {
    const [c, dialog] = useConfirm();
    confirm = c;
    return <>{dialog}</>;
  }
  render(<Harness />);
  return () => {
    let result!: Promise<boolean>;
    act(() => {
      result = confirm(options);
    });
    return result;
  };
}

describe("useConfirm", () => {
  it("shows the question in a dialog and resolves true when confirmed", async () => {
    const ask = setup();
    const answer = ask();
    expect(screen.getByRole("heading", { name: "Delete column?" })).toBeTruthy();
    expect(screen.getByText("To do will be deleted.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete column" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole("heading", { name: "Delete column?" })).toBeNull();
  });

  it("resolves false on Cancel", async () => {
    const ask = setup();
    const answer = ask();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false when dismissed with Escape (the dialog closes itself)", async () => {
    const ask = setup();
    const answer = ask();
    act(() => {
      (document.querySelector("dialog") as HTMLDialogElement).close();
    });
    await expect(answer).resolves.toBe(false);
  });

  it("puts focus on Cancel, so a reflexive Enter doesn't delete anything", () => {
    const ask = setup();
    void ask();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});
