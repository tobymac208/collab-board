"use client";

import { useEffect, useSyncExternalStore } from "react";
import { LIMITS, readText, type Card, type Viewer } from "@collab/shared";
import type { CardDocEntry } from "@/lib/card-docs";
import { Button, Modal } from "../ui";
import { useBoard } from "./board-context";
import { CrdtField, type CursorState } from "./crdt-field";

export function CardDialog({ card, onClose }: { card: Card | undefined; onClose: () => void }) {
  return (
    <Modal open={card !== undefined} onClose={onClose} title="Edit card">
      {/* Keyed so everything resets when a different card opens. */}
      {card && <CardEditor key={card.id} card={card} onClose={onClose} />}
    </Modal>
  );
}

/**
 * Live, shared editing of a card's title and description. There's no Save:
 * every keystroke goes into the card's CRDT document and reaches everyone
 * else viewing the board, merging with whatever they type at the same time.
 */
function CardEditor({ card, onClose }: { card: Card; onClose: () => void }) {
  const { mutate, othersOnCard, cardDocs, live, me } = useBoard();
  useSyncExternalStore(cardDocs.subscribe, cardDocs.version, cardDocs.version);

  // Open (and, online, sync) the document. Offline, a card can only start
  // from a seed, and only if its text hasn't changed since creation (version
  // 0), since the server seeds from the same text and the two must match.
  useEffect(() => {
    cardDocs.open(
      card.id,
      card.version === 0 ? { title: card.title, description: card.description } : undefined,
    );
  }, [cardDocs, card.id, card.version, card.title, card.description, live]);
  const entry = cardDocs.get(card.id);

  async function remove() {
    if (!confirm(`Delete “${card.title || "this card"}”?`)) return;
    onClose(); // the card disappears right away
    await mutate({ type: "delete_card", cardId: card.id });
  }

  const others = othersOnCard(card.id);

  return (
    <div className="flex flex-col gap-4">
      {others.length > 0 && <AlsoHere others={others} />}
      {entry ? <LiveFields entry={entry} card={card} me={me} /> : <ReadOnly card={card} />}
      <div className="flex items-center gap-2">
        <Button variant="danger" onClick={() => void remove()}>
          Delete
        </Button>
        <SyncStatus entry={entry} live={live} />
        <Button className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function LiveFields({
  entry,
  card,
  me,
}: {
  entry: CardDocEntry;
  card: Card;
  me: { name: string; color: string };
}) {
  // Show up in others' editors while this one is open.
  useEffect(() => {
    entry.awareness.setLocalState({ user: me, cursor: null } satisfies CursorState);
    return () => entry.awareness.setLocalState(null);
  }, [entry, me]);

  // A brand-new document that hasn't heard from the server yet is empty;
  // don't let someone type into that and then see the real text appear.
  const loading =
    !entry.synced &&
    readText(entry.doc, "title") === "" &&
    readText(entry.doc, "description") === "" &&
    (card.title !== "" || card.description !== "");
  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Title
        <CrdtField entry={entry} field="title" label="Title" maxLength={LIMITS.cardTitle} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Description
        <CrdtField
          entry={entry}
          field="description"
          label="Description"
          multiline
          maxLength={LIMITS.cardDescription}
          placeholder="Add more detail…"
        />
      </label>
    </>
  );
}

/** Offline, for a card whose text this browser doesn't have a copy of yet. */
function ReadOnly({ card }: { card: Card }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="rounded-md bg-zinc-100 px-3 py-2 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        You&apos;re offline, and this card&apos;s text hasn&apos;t been opened here before, so it
        can be edited once you reconnect.
      </p>
      <p className="font-medium">{card.title || "Untitled"}</p>
      {card.description && (
        <p className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{card.description}</p>
      )}
    </div>
  );
}

function SyncStatus({ entry, live }: { entry: CardDocEntry | undefined; live: boolean }) {
  if (!entry) return null;
  const text = !entry.dirty
    ? "All changes saved"
    : live
      ? "Saving…"
      : "Saved on this device · will sync when you're back online";
  return (
    <span className="text-xs text-zinc-500" role="status">
      {text}
    </span>
  );
}

function AlsoHere({ others }: { others: Viewer[] }) {
  const names = others.map((o) => o.displayName);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
    >
      <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
      {list} {others.length === 1 ? "is" : "are"} editing this card with you.
    </p>
  );
}
