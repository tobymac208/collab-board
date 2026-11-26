import { describe, expect, it } from "vitest";
import { fields } from "@collab/shared";
import { newId } from "./ids.ts";

describe("newId", () => {
  it("produces UUIDs the protocol accepts, without repeats", () => {
    const ids = Array.from({ length: 1000 }, newId);
    for (const id of ids) expect(fields.id.safeParse(id).success).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
