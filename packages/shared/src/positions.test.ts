import { describe, expect, it } from "vitest";
import { comparePositions } from "./model.ts";
import { initialPositions, positionAtEnd, positionBetweenNeighbours } from "./positions.ts";

const list = (...ids: string[]) => {
  const keys = initialPositions(ids.length);
  return ids.map((id, i) => ({ id, position: keys[i]! }));
};

/** Inserts `id` at the computed position and returns the resulting order. */
function orderAfterDrop(
  siblings: { id: string; position: string }[],
  afterId: string | null,
  beforeId: string | null,
) {
  const position = positionBetweenNeighbours(siblings, afterId, beforeId);
  return [...siblings, { id: "X", position }].sort(comparePositions).map((s) => s.id);
}

describe("positionBetweenNeighbours", () => {
  const abc = list("A", "B", "C");

  it("places between the given neighbours", () => {
    expect(orderAfterDrop(abc, "A", "B")).toEqual(["A", "X", "B", "C"]);
    expect(orderAfterDrop(abc, null, "A")).toEqual(["X", "A", "B", "C"]);
    expect(orderAfterDrop(abc, "C", null)).toEqual(["A", "B", "C", "X"]);
  });

  it("stays right after its upper neighbour when someone inserted in between", () => {
    // The user saw A, B and dropped between them; meanwhile N landed there too.
    const key = positionBetweenNeighbours(abc, "A", "B");
    const withN = [...abc, { id: "N", position: key }].sort(comparePositions);
    expect(orderAfterDrop(withN, "A", "B")).toEqual(["A", "X", "N", "B", "C"]);
  });

  it("falls back to the lower neighbour if the upper one is gone", () => {
    expect(orderAfterDrop(list("B", "C"), "A", "C")).toEqual(["B", "X", "C"]);
  });

  it("goes first when dropped at the top and its neighbour is gone", () => {
    expect(orderAfterDrop(list("B", "C"), null, "A")).toEqual(["X", "B", "C"]);
  });

  it("goes last when both neighbours are gone", () => {
    expect(orderAfterDrop(list("B", "C"), "A", "Z")).toEqual(["B", "C", "X"]);
  });

  it("handles an empty list", () => {
    expect(orderAfterDrop([], null, null)).toEqual(["X"]);
  });
});

describe("positionAtEnd", () => {
  it("sorts after everything", () => {
    const abc = list("A", "B", "C");
    expect(
      [...abc, { id: "X", position: positionAtEnd(abc) }].sort(comparePositions).at(-1)?.id,
    ).toBe("X");
  });
});
