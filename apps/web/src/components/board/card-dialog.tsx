"use client";

import { useState } from "react";
import { LIMITS, type Card, type CardField, type Viewer } from "@collab/shared";
import { Button, Input, Modal, Textarea } from "../ui";
import { useBoard } from "./board-context";

export function CardDialog({ card, onClose }: { card: Card | undefined; onClose: () => void }) {
  return (
    <Modal open={card !== undefined} onClose={onClose} title="Edit card">
      {/* Keyed so the form resets when a different card opens. */}
      {card && <CardForm key={card.id} card={card} onClose={onClose} />}
    </Modal>
  );
}

/** A field the user has edited: their text, and the card version they started from. */
type Draft = { value: string; baseVersion: number };

const LABELS: Record<CardField, string> = { title: "title", description: "description" };

/**
 * Editing works field by field. A field you haven't touched shows the card's
 * current value, so other people's edits appear live. Once you type in a
 * field, it keeps your text and remembers which card version you started
 * from. Saving sends only your fields with those versions; if someone else
 * changed one of them meanwhile, the server says so and you choose.
 */
function CardForm({ card, onClose }: { card: Card; onClose: () => void }) {
  const { mutate, othersOnCard } = useBoard();
  const [drafts, setDrafts] = useState<Partial<Record<CardField, Draft>>>({});
  const [conflicts, setConflicts] = useState<CardField[]>([]);
  const [saving, setSaving] = useState(false);

  const valueOf = (field: CardField) => drafts[field]?.value ?? card[field];

  const edit = (field: CardField, value: string) =>
    setDrafts((d) => ({
      ...d,
      [field]: { value, baseVersion: d[field]?.baseVersion ?? card.version },
    }));

  /** Drop our edit and show theirs. */
  const takeTheirs = (field: CardField) => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[field];
      return next;
    });
    setConflicts((c) => c.filter((f) => f !== field));
  };

  /** Keep our edit, now based on the version that includes theirs. */
  const keepMine = (field: CardField) => {
    setDrafts((d) => ({ ...d, [field]: { value: d[field]!.value, baseVersion: card.version } }));
    setConflicts((c) => c.filter((f) => f !== field));
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!valueOf("title").trim()) return;
    // Only fields that differ from what the card says now.
    const changes: Partial<Record<CardField, Draft>> = {};
    for (const field of ["title", "description"] as const) {
      const draft = drafts[field];
      if (!draft) continue;
      const value = field === "title" ? draft.value.trim() : draft.value;
      if (value !== card[field]) changes[field] = { ...draft, value };
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const result = await mutate(
      { type: "update_card", cardId: card.id, ...changes },
      { quiet: true },
    );
    setSaving(false);
    if (result.ok) {
      onClose();
    } else if (result.error.code === "conflict") {
      setConflicts(result.error.conflictingFields);
    } else {
      setConflicts([]);
      alert(result.error.message);
    }
  }

  async function remove() {
    if (!confirm(`Delete “${card.title}”?`)) return;
    onClose(); // the card disappears right away
    await mutate({ type: "delete_card", cardId: card.id });
  }

  const others = othersOnCard(card.id);

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      {others.length > 0 && <AlsoHere others={others} />}

      <label className="flex flex-col gap-1 text-sm font-medium">
        Title
        <Input
          value={valueOf("title")}
          onChange={(e) => edit("title", e.target.value)}
          required
          maxLength={LIMITS.cardTitle}
        />
      </label>
      {conflicts.includes("title") && (
        <ConflictNotice
          field="title"
          theirs={card.title}
          onUseTheirs={() => takeTheirs("title")}
          onKeepMine={() => keepMine("title")}
        />
      )}

      <label className="flex flex-col gap-1 text-sm font-medium">
        Description
        <Textarea
          value={valueOf("description")}
          onChange={(e) => edit("description", e.target.value)}
          rows={6}
          maxLength={LIMITS.cardDescription}
          placeholder="Add more detail…"
        />
      </label>
      {conflicts.includes("description") && (
        <ConflictNotice
          field="description"
          theirs={card.description}
          onUseTheirs={() => takeTheirs("description")}
          onKeepMine={() => keepMine("description")}
        />
      )}

      <div className="flex items-center gap-2">
        <Button variant="danger" onClick={() => void remove()}>
          Delete
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving || conflicts.length > 0 || !valueOf("title").trim()}
          >
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

function AlsoHere({ others }: { others: Viewer[] }) {
  const names = others.map((o) => o.displayName);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
    >
      <span className="size-2 rounded-full bg-amber-500" aria-hidden />
      {list} {others.length === 1 ? "has" : "have"} this card open too.
    </p>
  );
}

function ConflictNotice({
  field,
  theirs,
  onUseTheirs,
  onKeepMine,
}: {
  field: CardField;
  theirs: string;
  onUseTheirs: () => void;
  onKeepMine: () => void;
}) {
  return (
    <div
      role="alert"
      className="-mt-2 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
    >
      <p className="font-medium text-amber-900 dark:text-amber-200">
        Someone else changed the {LABELS[field]} while you were editing.
      </p>
      <p className="text-zinc-700 dark:text-zinc-300">
        Theirs: <span className="whitespace-pre-wrap italic">{theirs || "(empty)"}</span>
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onUseTheirs}>
          Use theirs
        </Button>
        <Button variant="secondary" onClick={onKeepMine}>
          Keep mine
        </Button>
      </div>
    </div>
  );
}
