"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card } from "@collab/shared";

const cardClass =
  "rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm shadow-xs dark:border-zinc-800 dark:bg-zinc-950";

function CardBody({ card }: { card: Card }) {
  return (
    <>
      <span className="break-words">{card.title}</span>
      {card.description && (
        <span className="mt-1 block text-xs text-zinc-500" aria-label="Has description">
          ≡
        </span>
      )}
    </>
  );
}

export function SortableCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card" },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
        else listeners?.onKeyDown?.(e);
      }}
      aria-roledescription="draggable card"
      className={`${cardClass} cursor-grab touch-none hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:border-zinc-600 ${isDragging ? "opacity-40" : ""}`}
    >
      <CardBody card={card} />
    </li>
  );
}

/** What follows the pointer while a card is dragged. */
export function CardPreview({ card }: { card: Card }) {
  return (
    <div className={`${cardClass} w-68 rotate-2 cursor-grabbing shadow-lg`}>
      <CardBody card={card} />
    </div>
  );
}
