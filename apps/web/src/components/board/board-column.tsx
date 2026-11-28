"use client";

import { useState } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LIMITS, type Card, type Column } from "@collab/shared";
import { newId } from "@/lib/ids";
import { Button, InlineEdit, Input, useConfirm } from "../ui";
import { SortableCard } from "./board-card";
import { useBoard } from "./board-context";

const columnClass =
  "flex max-h-full w-72 shrink-0 flex-col rounded-lg bg-zinc-100 dark:bg-zinc-900/70";

export function BoardColumn({
  column,
  cards,
  onOpenCard,
}: {
  column: Column;
  cards: Card[];
  onOpenCard: (cardId: string) => void;
}) {
  const { mutate } = useBoard();
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.id, data: { type: "column" } });

  const [confirm, confirmDialog] = useConfirm();

  async function remove() {
    const ok = await confirm({
      title: "Delete column?",
      message: cards.length ? (
        <>
          <strong>{column.name}</strong> and its {cards.length} card
          {cards.length === 1 ? "" : "s"} will be deleted for everyone on this board.
        </>
      ) : (
        <>
          <strong>{column.name}</strong> will be deleted for everyone on this board.
        </>
      ),
      confirmLabel: "Delete column",
      danger: true,
    });
    if (ok) await mutate({ type: "delete_column", columnId: column.id });
  }

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`${columnClass} ${isDragging ? "opacity-40" : ""}`}
      aria-label={column.name}
    >
      <header className="flex items-center gap-1 px-2 pt-2">
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move column ${column.name}`}
          className="cursor-grab touch-none rounded px-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 active:cursor-grabbing dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          ⠿
        </button>
        <InlineEdit
          value={column.name}
          label="column"
          maxLength={LIMITS.columnName}
          onSave={(name) => void mutate({ type: "rename_column", columnId: column.id, name })}
          className="flex-1 text-sm font-semibold"
        />
        <span className="text-xs text-zinc-500">{cards.length}</span>
        <Button
          variant="ghost"
          className="px-1.5! py-0.5!"
          onClick={() => void remove()}
          aria-label={`Delete column ${column.name}`}
        >
          ×
        </Button>
      </header>

      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ol className="flex min-h-10 flex-col gap-2 overflow-y-auto p-2">
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} onOpen={() => onOpenCard(card.id)} />
          ))}
        </ol>
      </SortableContext>

      <AddCard columnId={column.id} />
      {confirmDialog}
    </section>
  );
}

/** What follows the pointer while a column is dragged. */
export function ColumnPreview({ column, cardCount }: { column: Column; cardCount: number }) {
  return (
    <div className={`${columnClass} rotate-1 p-3 shadow-xl`}>
      <span className="text-sm font-semibold">{column.name}</span>
      <span className="text-xs text-zinc-500">
        {cardCount} card{cardCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function AddCard({ columnId }: { columnId: string }) {
  const { mutate } = useBoard();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="m-2 mt-0 rounded-md px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        + Add a card
      </button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    // Keep the form open so several cards can be added in a row. The card
    // appears right away; if the server refuses it, put the text back.
    setTitle("");
    const result = await mutate({ type: "create_card", columnId, title: trimmed, id: newId() });
    if (!result.ok) setTitle(trimmed);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 p-2 pt-0">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setAdding(false);
        }}
        placeholder="Card title"
        aria-label="New card title"
        maxLength={LIMITS.cardTitle}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={!title.trim()}>
          Add card
        </Button>
        <Button variant="ghost" onClick={() => setAdding(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
