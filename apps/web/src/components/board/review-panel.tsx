"use client";

import type { BoardOp, BoardState, RejectedOp } from "@/lib/board-state";
import { Button, Modal } from "../ui";

/** A plain-language description of a change, using current names where possible. */
export function describeOp(op: BoardOp, board: BoardState): string {
  const card = (id: string) => {
    const title = board.cards[id]?.title;
    return title ? `“${title}”` : "a card that's since been deleted";
  };
  const column = (id: string) => {
    const name = board.columns[id]?.name;
    return name ? `“${name}”` : "a column that's since been deleted";
  };
  switch (op.type) {
    case "rename_board":
      return `Rename the board to “${op.name}”`;
    case "create_column":
      return `Add the column “${op.name}”`;
    case "rename_column":
      return `Rename column ${column(op.columnId)} to “${op.name}”`;
    case "move_column":
      return `Move column ${column(op.columnId)}`;
    case "delete_column":
      return `Delete column ${column(op.columnId)}`;
    case "create_card":
      return `Add the card “${op.title}” to ${column(op.columnId)}`;
    case "move_card":
      return `Move ${card(op.cardId)} to ${column(op.toColumnId)}`;
    case "delete_card":
      return `Delete ${card(op.cardId)}`;
  }
}

/** Why the server refused it, in terms the user can act on. */
export function explainRejection(rejected: RejectedOp): string {
  if (rejected.code === "not_found") return "It was deleted by someone else meanwhile.";
  if (rejected.code === "forbidden") return "You no longer have permission to do that.";
  return rejected.message;
}

/**
 * Changes made offline that the server refused once we reconnected (moves
 * and deletes of things others removed meanwhile, say). Nothing is lost
 * silently: each is listed with the reason. Card text never ends up here,
 * since it merges.
 */
export function ReviewPanel({
  open,
  onClose,
  rejected,
  board,
  onDismiss,
}: {
  open: boolean;
  onClose: () => void;
  rejected: RejectedOp[];
  board: BoardState;
  onDismiss: (opId: string) => void;
}) {
  return (
    <Modal open={open && rejected.length > 0} onClose={onClose} title="Offline changes to review">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        These changes were made while you were offline, and couldn&apos;t be applied once you
        reconnected. Everything else you did offline went through.
      </p>
      <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {rejected.map((r) => (
          <li key={r.op.opId} className="flex items-start gap-3 py-3 text-sm">
            <div className="flex-1">
              <p className="font-medium">{describeOp(r.op, board)}</p>
              <p className="text-zinc-500">{explainRejection(r)}</p>
            </div>
            <Button variant="ghost" onClick={() => onDismiss(r.op.opId)}>
              Discard
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            for (const r of rejected) onDismiss(r.op.opId);
            onClose();
          }}
        >
          Discard all
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
