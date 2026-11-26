"use client";

import Link from "next/link";
import { useMemo, useReducer, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { LIMITS, type ServerEvent } from "@collab/shared";
import {
  applyEvent,
  findColumnOf,
  layoutOf,
  moveCardInLayout,
  moveColumnInLayout,
  type BoardState,
  type Layout,
} from "@/lib/board-state";
import { RequestError } from "@/lib/sync-client";
import { useOnConnected, useRequest, useServerEvents, useSyncClient } from "@/lib/sync";
import { Button, InlineEdit, Input } from "../ui";
import { BoardColumn, ColumnPreview } from "./board-column";
import { CardPreview } from "./board-card";
import { CardDialog } from "./card-dialog";
import { ShareDialog } from "./share-dialog";

type Loaded = { data: BoardState | null; deleted: boolean };

type DragItem = { type: "card" | "column"; id: string };

const dragType = (data: { current?: Record<string, unknown> | undefined }) =>
  data.current?.type as DragItem["type"] | undefined;

/**
 * Columns only collide with columns. Cards use closest corners, which works
 * well for stacked lists and still finds empty columns.
 */
const collisionDetection: CollisionDetection = (args) => {
  if (dragType(args.active.data) === "column") {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => dragType(c.data) === "column"),
    });
  }
  return closestCorners(args);
};

export function BoardView({ boardId }: { boardId: string }) {
  const client = useSyncClient();
  const request = useRequest();

  const [{ data: state, deleted }, dispatch] = useReducer(
    (s: Loaded, event: ServerEvent): Loaded => {
      const data = applyEvent(s.data, event, boardId);
      return data === s.data ? s : { data, deleted: s.data !== null && data === null };
    },
    { data: null, deleted: false },
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useServerEvents(dispatch);

  // (Re)load the whole board every time the connection opens. After a
  // reconnect this replaces whatever we had with the server's current state.
  useOnConnected(() => {
    client.request({ type: "open_board", boardId }).then(
      () => setLoadError(null),
      (err: RequestError) => {
        if (err.code !== "disconnected") setLoadError(err.message);
      },
    );
  });

  // ---- drag and drop ------------------------------------------------------
  //
  // While dragging, and until the server confirms the move, we render from a
  // local layout instead of server state, so the dropped item doesn't jump
  // back for a moment. (Phase 3 replaces this with proper optimistic updates.)

  const serverLayout = useMemo(() => (state ? layoutOf(state) : null), [state]);
  const [dragLayout, setDragLayout] = useState<Layout | null>(null);
  const [active, setActive] = useState<DragItem | null>(null);
  const draggingRef = useRef(false);
  const pendingMovesRef = useRef(0);
  const layout = dragLayout ?? serverLayout;

  const sensors = useSensors(
    // A small distance threshold keeps plain clicks working (to open cards).
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Space picks up and drops; Enter is left free to open a card.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  /** Drops the local layout once nothing is being dragged or awaiting the server. */
  const settle = () => {
    if (!draggingRef.current && pendingMovesRef.current === 0) setDragLayout(null);
  };

  async function sendMove(next: Layout, body: Parameters<typeof request>[0]) {
    setDragLayout(next);
    pendingMovesRef.current++;
    await request(body);
    pendingMovesRef.current--;
    settle();
  }

  function onDragStart({ active: item }: DragStartEvent) {
    const type = dragType(item.data);
    if (!type || !serverLayout) return;
    draggingRef.current = true;
    setActive({ type, id: String(item.id) });
    setDragLayout((current) => current ?? serverLayout);
  }

  // Moving a card into another column happens during the drag, so the
  // target column opens up a gap for it.
  function onDragOver({ active: item, over }: DragOverEvent) {
    if (!over || dragType(item.data) !== "card") return;
    setDragLayout((current) => {
      if (!current) return current;
      const cardId = String(item.id);
      const overId = String(over.id);
      const from = findColumnOf(current, cardId);
      const to = dragType(over.data) === "column" ? overId : findColumnOf(current, overId);
      if (!from || !to || from === to) return current;
      const targetCards = current.cardsByColumn[to] ?? [];
      const overIndex = targetCards.indexOf(overId);
      const translated = item.rect.current.translated;
      const below = translated ? translated.top > over.rect.top + over.rect.height / 2 : false;
      const index = overIndex === -1 ? targetCards.length : overIndex + (below ? 1 : 0);
      return moveCardInLayout(current, cardId, to, index);
    });
  }

  function onDragEnd({ active: item, over }: DragEndEvent) {
    draggingRef.current = false;
    setActive(null);
    const current = dragLayout;
    if (!over || !current || !serverLayout) {
      settle();
      return;
    }
    const id = String(item.id);
    const overId = String(over.id);

    if (dragType(item.data) === "column") {
      const targetColumn =
        dragType(over.data) === "column" ? overId : (findColumnOf(current, overId) ?? id);
      const toIndex = current.columnOrder.indexOf(targetColumn);
      if (toIndex === -1 || serverLayout.columnOrder.indexOf(id) === toIndex) {
        settle();
        return;
      }
      void sendMove(moveColumnInLayout(current, id, toIndex), {
        type: "move_column",
        columnId: id,
        toIndex,
      });
      return;
    }

    const column = findColumnOf(current, id);
    if (!column) {
      settle();
      return;
    }
    const cards = current.cardsByColumn[column]!;
    const overIndex = cards.indexOf(overId);
    const toIndex = overIndex === -1 ? cards.indexOf(id) : overIndex;
    const next = moveCardInLayout(current, id, column, toIndex);
    const unchanged =
      findColumnOf(serverLayout, id) === column &&
      serverLayout.cardsByColumn[column]?.indexOf(id) === toIndex;
    if (unchanged) {
      settle();
      return;
    }
    void sendMove(next, { type: "move_card", cardId: id, toColumnId: column, toIndex });
  }

  function onDragCancel() {
    draggingRef.current = false;
    setActive(null);
    settle();
  }

  // Screen reader announcements that use names instead of ids.
  const describe = (id: string | number) => {
    const key = String(id);
    return state?.cards[key]?.title ?? state?.columns[key]?.name ?? "item";
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up ${describe(a.id)}.`,
    onDragOver: ({ active: a, over }) =>
      over
        ? `${describe(a.id)} is over ${describe(over.id)}.`
        : `${describe(a.id)} is not over a drop target.`,
    onDragEnd: ({ active: a, over }) =>
      over ? `Dropped ${describe(a.id)} at ${describe(over.id)}.` : `Dropped ${describe(a.id)}.`,
    onDragCancel: ({ active: a }) => `Cancelled moving ${describe(a.id)}.`,
  };

  // ---- render -------------------------------------------------------------

  if (deleted || loadError) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-zinc-600 dark:text-zinc-400">
          {deleted ? "This board was deleted." : loadError}
        </p>
        <Link href="/boards" className="text-sm font-medium underline">
          Back to your boards
        </Link>
      </main>
    );
  }
  if (!state || !layout) {
    return <main className="flex-1 p-6 text-sm text-zinc-500">Loading board…</main>;
  }

  const isOwner = state.board.role === "owner";
  const openCard = openCardId ? state.cards[openCardId] : undefined;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
        <InlineEdit
          value={state.board.name}
          label="board"
          maxLength={LIMITS.boardName}
          disabled={!isOwner}
          onSave={(name) => void request({ type: "rename_board", boardId, name })}
          className="text-xl font-semibold tracking-tight"
        />
        <div className="ml-auto flex items-center gap-3">
          <div className="flex -space-x-2" aria-label="Members">
            {state.members.map((m) => (
              <span
                key={m.userId}
                title={`${m.displayName} (${m.role})`}
                className="flex size-7 items-center justify-center rounded-full border-2 border-white bg-zinc-200 text-xs font-medium text-zinc-700 dark:border-zinc-950 dark:bg-zinc-700 dark:text-zinc-200"
              >
                {m.displayName.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </div>
          <Button variant="secondary" onClick={() => setSharing(true)}>
            {isOwner ? "Share" : "Members"}
          </Button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={{ announcements }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="flex min-h-0 flex-1 items-start gap-4 overflow-x-auto p-6">
          <SortableContext items={layout.columnOrder} strategy={horizontalListSortingStrategy}>
            {layout.columnOrder.map((columnId) => {
              const column = state.columns[columnId];
              if (!column) return null;
              const cards = (layout.cardsByColumn[columnId] ?? [])
                .map((id) => state.cards[id])
                .filter((c) => c !== undefined);
              return (
                <BoardColumn
                  key={columnId}
                  column={column}
                  cards={cards}
                  onOpenCard={setOpenCardId}
                />
              );
            })}
          </SortableContext>
          <AddColumn boardId={boardId} />
        </div>

        <DragOverlay>
          {active?.type === "card" && state.cards[active.id] ? (
            <CardPreview card={state.cards[active.id]!} />
          ) : active?.type === "column" && state.columns[active.id] ? (
            <ColumnPreview
              column={state.columns[active.id]!}
              cardCount={layout.cardsByColumn[active.id]?.length ?? 0}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <CardDialog card={openCard} onClose={() => setOpenCardId(null)} />
      <ShareDialog
        open={sharing}
        onClose={() => setSharing(false)}
        boardId={boardId}
        members={state.members}
        isOwner={isOwner}
      />
    </main>
  );
}

function AddColumn({ boardId }: { boardId: string }) {
  const request = useRequest();
  const [name, setName] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (await request({ type: "create_column", boardId, name: trimmed })) setName("");
  }

  return (
    <form onSubmit={submit} className="flex w-72 shrink-0 gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add a column"
        aria-label="New column name"
        maxLength={LIMITS.columnName}
      />
      <Button type="submit" variant="secondary" disabled={!name.trim()}>
        Add
      </Button>
    </form>
  );
}
