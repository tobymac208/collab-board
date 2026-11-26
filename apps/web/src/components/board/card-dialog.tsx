"use client";

import { useState } from "react";
import { LIMITS, type Card } from "@collab/shared";
import { useRequest } from "@/lib/sync";
import { Button, Input, Modal, Textarea } from "../ui";

export function CardDialog({ card, onClose }: { card: Card | undefined; onClose: () => void }) {
  return (
    <Modal open={card !== undefined} onClose={onClose} title="Edit card">
      {/* Keyed so the form resets when a different card opens. */}
      {card && <CardForm key={card.id} card={card} onClose={onClose} />}
    </Modal>
  );
}

function CardForm({ card, onClose }: { card: Card; onClose: () => void }) {
  const request = useRequest();
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    const changes = {
      ...(trimmed !== card.title ? { title: trimmed } : {}),
      ...(description !== card.description ? { description } : {}),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const ok = await request({ type: "update_card", cardId: card.id, ...changes });
    setSaving(false);
    if (ok) onClose();
  }

  async function remove() {
    if (!confirm(`Delete “${card.title}”?`)) return;
    if (await request({ type: "delete_card", cardId: card.id })) onClose();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Title
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={LIMITS.cardTitle}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Description
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          maxLength={LIMITS.cardDescription}
          placeholder="Add more detail…"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button variant="danger" onClick={() => void remove()}>
          Delete
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !title.trim()}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
