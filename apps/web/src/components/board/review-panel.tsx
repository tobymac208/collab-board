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
    case "update_card": {
      const fields = [op.title && "title", op.description && "description"].filter(Boolean);
      return `Edit the ${fields.join(" and ")} of ${card(op.cardId)}`;
    }
    case "move_card":
      return `Move ${card(op.cardId)} to ${column(op.toColumnId)}`;
    case "delete_card":
      return `Delete ${card(op.cardId)}`;
  }
}

/** Why the server refused it, in terms the user can act on. */
export function explainRejection(rejected: RejectedOp): string {
  if (rejected.code === "conflict" && rejected.conflictingFields.length > 0) {
    return `Someone else changed the ${rejected.conflictingFields.join(" and ")} meanwhile.`;
  }
  if (rejected.code === "not_found") return "It was deleted by someone else meanwhile.";
  if (rejected.code === "forbidden") return "You no longer have permission to do that.";
  return rejected.message;
}

/** Card text clashes can be reopened in the editor; the card must still exist. */
const canResolve = (rejected: RejectedOp, board: BoardState) =>
  rejected.op.type === "update_card" &&
  rejected.code === "conflict" &&
  board.cards[rejected.op.cardId] !== undefined;

/**
 * Changes made offline that the server refused once we reconnected. Nothing
 * is lost silently: each is listed with the reason, and card text clashes
 * can be reopened in the editor to choose between theirs and yours.
 */
export function ReviewPanel({
  open,
  onClose,
  rejected,
  board,
  onDismiss,
  onResolve,
}: {
  open: boolean;
  onClose: () => void;
  rejected: RejectedOp[];
  board: BoardState;
  onDismiss: (opId: string) => void;
  onResolve: (rejected: RejectedOp) => void;
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
            {canResolve(r, board) && (
              <Button variant="secondary" onClick={() => onResolve(r)}>
                Resolve
              </Button>
            )}
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
