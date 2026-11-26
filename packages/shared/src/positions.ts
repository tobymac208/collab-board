import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Ordering with fractional index keys. Shared by the server (which decides)
 * and the client (which predicts the result for optimistic updates), so both
 * place an item in the same spot given the same siblings.
 *
 * Keys compare byte-wise; see `comparePositions`.
 */

export interface Positioned {
  id: string;
  position: string;
}

/** `count` keys in ascending order, for a brand-new list. */
export function initialPositions(count: number): string[] {
  return generateNKeysBetween(null, null, count);
}

/** A key after every key in `sorted`. */
export function positionAtEnd(sorted: readonly Positioned[]): string {
  return generateKeyBetween(sorted.at(-1)?.position ?? null, null);
}

/**
 * Where to put an item the user dropped between two neighbours.
 *
 * `afterId`/`beforeId` are the items directly above/below the drop point as
 * the user saw them (null at the start/end of the list). By the time the move
 * reaches the server, others may have moved or deleted those neighbours, or
 * inserted items between them, so the rules keep the user's intent as best
 * they can:
 *
 * 1. If `afterId` is still in the list, go directly after it.
 * 2. Otherwise, if `beforeId` is, go directly before it.
 * 3. Otherwise, if the user dropped at the top (`afterId` null), go first.
 * 4. Otherwise, go last.
 *
 * `siblings` must be sorted by position and must not include the moved item.
 */
export function positionBetweenNeighbours(
  siblings: readonly Positioned[],
  afterId: string | null,
  beforeId: string | null,
): string {
  const at = (i: number) => siblings[i]?.position ?? null;
  if (afterId !== null) {
    const i = siblings.findIndex((s) => s.id === afterId);
    if (i !== -1) return generateKeyBetween(at(i), at(i + 1));
  }
  if (beforeId !== null) {
    const i = siblings.findIndex((s) => s.id === beforeId);
    if (i !== -1) return generateKeyBetween(at(i - 1), at(i));
  }
  if (afterId === null) return generateKeyBetween(null, at(0));
  return positionAtEnd(siblings);
}
