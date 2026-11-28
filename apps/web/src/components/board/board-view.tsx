"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { LIMITS, readText, type BoardMember, type Viewer } from "@collab/shared";
import { useAuth } from "@/lib/auth";
import {
  boardReducer,
  findColumnOf,
  hasGap,
  initialSync,
  layoutOf,
  moveCardInLayout,
  moveColumnInLayout,
  unsentOps,
  viewOf,
  type BoardAction,
  type BoardOp,
  type BoardSync,
  type Layout,
  type LocalOp,
} from "@/lib/board-state";
import { CardDocs } from "@/lib/card-docs";
import { newId } from "@/lib/ids";
import { forgetBoard, restoreBoard, saveBoard } from "@/lib/offline-store";
import { RequestError } from "@/lib/sync-client";
import {
  useConnectionStatus,
  useNotify,
  useOnConnected,
  useServerEvents,
  useSyncClient,
} from "@/lib/sync";
import { Button, InlineEdit, Input } from "../ui";
import { BoardColumn, ColumnPreview } from "./board-column";
import { CardPreview } from "./board-card";
import {
  BoardContext,
  useBoard,
  type BoardContextValue,
  type MutationResult,
} from "./board-context";
import { CardDialog } from "./card-dialog";
import { colorFor } from "./crdt-field";
import { ReviewPanel } from "./review-panel";
import { ShareDialog } from "./share-dialog";

/** How long to wait for a missing revision before reloading the board. */
const GAP_TIMEOUT_MS = 1_500;

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
  const notify = useNotify();
  const { state: auth } = useAuth();
  const myUserId = auth.status === "authenticated" ? auth.user.id : null;
  const connected = useConnectionStatus().status === "open";

  const [sync, dispatch] = useReducer(
    (s: BoardSync, action: BoardAction) => boardReducer(s, action, boardId),
    initialSync,
  );
  /** Confirmed state with our own pending changes on top: what we show. */
  const state = useMemo(() => viewOf(sync), [sync]);
  const { deleted, viewers } = sync;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  /** The board has been loaded or caught up on the current connection. */
  const [loaded, setLoaded] = useState(false);
  const live = connected && loaded;

  /** Card text documents for this board (live titles and descriptions). */
  const [cardDocs] = useState(
    () =>
      new CardDocs(
        boardId,
        (body) => client.request(body),
        (message) => notify(message),
      ),
  );
  useEffect(() => () => cardDocs.destroy(), [cardDocs]);
  const docsVersion = useSyncExternalStore(cardDocs.subscribe, cardDocs.version, () => 0);
  useEffect(() => cardDocs.setLive(live), [cardDocs, live]);

  useServerEvents((event) => {
    // Someone else deleting the card you're editing closes the editor; say why.
    if (!event.requestId && openCardId && state) {
      const gone =
        (event.type === "card_deleted" && event.cardId === openCardId) ||
        (event.type === "column_deleted" && state.cards[openCardId]?.columnId === event.columnId);
      if (gone) notify("Someone else deleted the card you were editing.");
    }
    dispatch({ kind: "event", event });
    cardDocs.handle(event);
  });

  // ---- saved in the browser -------------------------------------------------
  //
  // Restored in an effect rather than during render, so the server-rendered
  // page and the first browser render agree; the board appears a moment later.

  /** The revision of the saved copy we restored, for catching up from it. */
  const restoredRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!myUserId) return;
    // Not cancelled on cleanup: restoring also adopts (and removes) queues of
    // closed tabs, and dropping that result would lose them. Restoring twice
    // is harmless; the reducer merges by opId.
    void restoreBoard(myUserId, boardId).then((saved) => {
      if (!saved) return;
      restoredRevision.current = saved.data?.revision;
      dispatch({ kind: "restored", data: saved.data, ops: saved.ops, rejected: saved.rejected });
      if (saved.docs) cardDocs.import(saved.docs);
    });
  }, [myUserId, boardId, cardDocs]);

  /** False when the browser refused to save (storage full or blocked). */
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    if (!myUserId || !sync.data) return;
    // Card documents are saved too, except for cards that no longer exist.
    const docs = Object.fromEntries(
      Object.entries(cardDocs.export()).filter(([cardId]) => sync.data?.cards[cardId]),
    );
    void saveBoard(myUserId, boardId, {
      data: sync.data,
      ops: sync.ops,
      rejected: sync.rejected,
      docs,
    }).then((ok) => setSaveFailed(!ok));
  }, [myUserId, boardId, sync.data, sync.ops, sync.rejected, cardDocs, docsVersion]);

  useEffect(() => {
    if (deleted && myUserId) forgetBoard(myUserId, boardId);
  }, [deleted, myUserId, boardId]);

  // ---- loading and catching up --------------------------------------------

  /**
   * Loads the board and subscribes to its changes. If we already have it at
   * some revision (from this visit or a saved copy), asks only for the
   * changes since, which the server sends as ordinary events.
   */
  const load = () => {
    setLoaded(false);
    // Catch up from what we actually have: the board as shown, or the saved
    // copy we restored. (Not a fresh read of storage, which another tab may
    // have moved on since.)
    const since = sync.data?.revision ?? restoredRevision.current;
    client
      .request({
        type: "open_board",
        boardId,
        ...(since === undefined ? {} : { sinceRevision: since }),
      })
      .then(
        () => {
          setLoadError(null);
          setLoaded(true);
        },
        (err: RequestError) => {
          if (err.code === "disconnected") return;
          if (err.code === "not_found" && myUserId) forgetBoard(myUserId, boardId);
          setLoadError(err.message);
        },
      );
  };

  // Every time the connection opens: catch up, then (below) send what's queued.
  useOnConnected(load);

  // Tell others which card we have open. On a (re)connect this runs after
  // the load above, and the server handles a socket's requests in order.
  useEffect(() => {
    if (!connected) return;
    client.request({ type: "focus_card", boardId, cardId: openCardId }).catch(() => {
      // Presence is best-effort.
    });
  }, [client, boardId, openCardId, connected]);

  // Leaving the page: stop receiving this board's changes and presence.
  useEffect(
    () => () => {
      client.request({ type: "close_board", boardId }).catch(() => {
        // Not connected: the server already dropped the subscription.
      });
    },
    [client, boardId],
  );

  // A change arrived ahead of one we never got. Give it a moment to show up,
  // then catch up rather than stay out of date.
  const gap = hasGap(sync);
  const reload = useEffectEvent(load);
  useEffect(() => {
    if (!gap) return;
    const timer = setTimeout(reload, GAP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [gap]);

  // ---- our own changes ------------------------------------------------------
  //
  // Every change goes into `sync.ops` first and shows immediately. While the
  // board is live, the effect below sends unsent ops in order. Offline, they
  // wait; on reconnect (after catching up) they're sent then. Each op keeps
  // its opId across attempts, so a resend after a dropped connection is
  // applied once.

  /** Ops sent on the current connection, so each goes out once per connection. */
  const sent = useRef(new Set<string>());
  /** Callers waiting to hear how their change went (e.g. the card editor). */
  const waiting = useRef(
    new Map<string, { resolve: (result: MutationResult) => void; quiet: boolean }>(),
  );

  useEffect(() => {
    if (!connected) sent.current.clear(); // resend everything unconfirmed next time
  }, [connected]);

  const settle = (opId: string, result: MutationResult) => {
    waiting.current.get(opId)?.resolve(result);
    waiting.current.delete(opId);
  };

  const send = useEffectEvent((local: LocalOp) => {
    const { opId } = local.op;
    client.request(local.op).then(
      (events) => {
        const revision = Math.max(0, ...events.map((e) => ("revision" in e ? e.revision : 0)));
        dispatch({ kind: "op_confirmed", opId, revision });
        settle(opId, { ok: true });
      },
      (err: RequestError) => {
        if (err.code === "disconnected") {
          // Unknown whether it arrived: resend after reconnecting, same opId.
          sent.current.delete(opId);
          dispatch({ kind: "op_deferred", opId });
          settle(opId, { ok: true, queued: true });
          return;
        }
        if (local.deferred) {
          const error = { code: err.code, message: err.message };
          dispatch({ kind: "op_rejected", opId, error });
        } else {
          dispatch({ kind: "op_failed", opId }); // rolls back
          if (!waiting.current.get(opId)?.quiet) notify(err.message);
        }
        settle(opId, { ok: false, error: err });
      },
    );
  });

  useEffect(() => {
    if (!live) return;
    for (const local of sync.ops) {
      if (local.confirmedAt !== undefined || sent.current.has(local.op.opId)) continue;
      sent.current.add(local.op.opId);
      send(local);
    }
  }, [live, sync.ops]);

  const mutate = useCallback<BoardContextValue["mutate"]>(
    (input, { quiet = false } = {}) => {
      const op = { ...input, opId: newId() } as BoardOp;
      dispatch({ kind: "op_started", op, deferred: !live }); // shows up right away
      if (!live) return Promise.resolve({ ok: true, queued: true });
      return new Promise((resolve) => waiting.current.set(op.opId, { resolve, quiet }));
    },
    [live],
  );

  const me = useMemo(
    () => ({
      name: auth.status === "authenticated" ? auth.user.displayName : "",
      color: colorFor(myUserId ?? ""),
    }),
    [auth, myUserId],
  );

  const boardContext = useMemo<BoardContextValue>(
    () => ({
      mutate,
      othersOnCard: (cardId) =>
        viewers.filter((v) => v.userId !== myUserId && v.cardIds.includes(cardId)),
      cardDocs,
      live,
      me,
    }),
    [mutate, viewers, myUserId, cardDocs, live, me],
  );

  const unsent = unsentOps(sync).length + cardDocs.dirtyCount();

  /**
   * What tiles show: card text straight from open documents, so titles update
   * as people type rather than when the plain-text copy is next saved.
   */
  const shown = useMemo(() => {
    if (!state) return state;
    void docsVersion; // recompute when any document changes
    let cards = state.cards;
    for (const { cardId, doc, synced, dirty } of cardDocs.entries()) {
      const card = cards[cardId];
      if (!card || (!synced && !dirty)) continue; // not trustworthy yet
      const title = readText(doc, "title");
      const description = readText(doc, "description");
      if (title !== card.title || description !== card.description) {
        cards = { ...cards, [cardId]: { ...card, title, description } };
      }
    }
    return cards === state.cards ? state : { ...state, cards };
  }, [state, cardDocs, docsVersion]);

  // ---- drag and drop ------------------------------------------------------
  //
  // While dragging, dnd-kit needs a layout it controls (a card moves between
  // columns as you hover), so we render from a local copy taken at the start
  // of the drag. On drop the move becomes an optimistic op naming the
  // neighbours the item landed between, and the local copy is discarded in
  // the same render, so nothing jumps.

  const viewLayout = useMemo(() => (state ? layoutOf(state) : null), [state]);
  const [dragLayout, setDragLayout] = useState<Layout | null>(null);
  const [active, setActive] = useState<DragItem | null>(null);
  const layout = dragLayout ?? viewLayout;

  const sensors = useSensors(
    // A small distance threshold keeps plain clicks working (to open cards).
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Space picks up and drops; Enter is left free to open a card.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  function endDrag() {
    setActive(null);
    setDragLayout(null);
  }

  function onDragStart({ active: item }: DragStartEvent) {
    const type = dragType(item.data);
    if (!type || !viewLayout) return;
    setActive({ type, id: String(item.id) });
    setDragLayout(viewLayout);
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
    const current = dragLayout;
    endDrag();
    if (!over || !current || !viewLayout) return;
    const id = String(item.id);
    const overId = String(over.id);

    if (dragType(item.data) === "column") {
      const target =
        dragType(over.data) === "column" ? overId : (findColumnOf(current, overId) ?? id);
      const toIndex = current.columnOrder.indexOf(target);
      if (toIndex === -1 || viewLayout.columnOrder.indexOf(id) === toIndex) return;
      const order = moveColumnInLayout(current, id, toIndex).columnOrder;
      void mutate({ type: "move_column", columnId: id, ...neighbours(order, id) });
      return;
    }

    const column = findColumnOf(current, id);
    if (!column) return;
    const cards = current.cardsByColumn[column]!;
    const overIndex = cards.indexOf(overId);
    const toIndex = overIndex === -1 ? cards.indexOf(id) : overIndex;
    const unchanged =
      findColumnOf(viewLayout, id) === column &&
      viewLayout.cardsByColumn[column]?.indexOf(id) === toIndex;
    if (unchanged) return;
    const list = moveCardInLayout(current, id, column, toIndex).cardsByColumn[column]!;
    void mutate({ type: "move_card", cardId: id, toColumnId: column, ...neighbours(list, id) });
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
  if (!shown || !layout) {
    return <main className="flex-1 p-6 text-sm text-zinc-500">Loading board…</main>;
  }

  const isOwner = shown.board.role === "owner";

  return (
    <BoardContext value={boardContext}>
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
          <InlineEdit
            value={shown.board.name}
            label="board"
            maxLength={LIMITS.boardName}
            disabled={!isOwner}
            onSave={(name) => void mutate({ type: "rename_board", boardId, name })}
            className="text-xl font-semibold tracking-tight"
          />
          <div className="ml-auto flex items-center gap-3">
            {unsent > 0 && (
              <span className="text-xs text-zinc-500" role="status">
                {live
                  ? `Syncing ${unsent} change${unsent === 1 ? "" : "s"}…`
                  : `${unsent} unsent change${unsent === 1 ? "" : "s"} · will sync when you're back online`}
              </span>
            )}
            <Presence members={shown.members} viewers={viewers} />
            <Button variant="secondary" onClick={() => setSharing(true)}>
              {isOwner ? "Share" : "Members"}
            </Button>
          </div>
        </div>

        {saveFailed && unsent > 0 && (
          <div
            role="alert"
            className="mx-6 mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
          >
            Your unsent changes couldn&apos;t be saved in this browser (storage is full or blocked).
            Keep this tab open until they&apos;ve synced, or they&apos;ll be lost.
          </div>
        )}

        {sync.rejected.length > 0 && (
          <div
            role="alert"
            className="mx-6 mt-3 flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {sync.rejected.length === 1
              ? "1 change you made offline couldn't be applied."
              : `${sync.rejected.length} changes you made offline couldn't be applied.`}
            <Button variant="secondary" className="ml-auto" onClick={() => setReviewing(true)}>
              Review
            </Button>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          accessibility={{ announcements }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          <div className="flex min-h-0 flex-1 items-start gap-4 overflow-x-auto p-6">
            <SortableContext items={layout.columnOrder} strategy={horizontalListSortingStrategy}>
              {layout.columnOrder.map((columnId) => {
                const column = shown.columns[columnId];
                if (!column) return null;
                const cards = (layout.cardsByColumn[columnId] ?? [])
                  .map((id) => shown.cards[id])
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
            {active?.type === "card" && shown.cards[active.id] ? (
              <CardPreview card={shown.cards[active.id]!} />
            ) : active?.type === "column" && shown.columns[active.id] ? (
              <ColumnPreview
                column={shown.columns[active.id]!}
                cardCount={layout.cardsByColumn[active.id]?.length ?? 0}
              />
            ) : null}
          </DragOverlay>
        </DndContext>

        <CardDialog
          card={openCardId ? shown.cards[openCardId] : undefined}
          onClose={() => setOpenCardId(null)}
        />
        <ReviewPanel
          open={reviewing}
          onClose={() => setReviewing(false)}
          rejected={sync.rejected}
          board={shown}
          onDismiss={(opId) => dispatch({ kind: "rejected_dismissed", opId })}
        />
        <ShareDialog
          open={sharing}
          onClose={() => setSharing(false)}
          boardId={boardId}
          members={shown.members}
          isOwner={isOwner}
        />
      </main>
    </BoardContext>
  );
}

/** The items directly before and after `id` in an ordered list. */
function neighbours(list: string[], id: string) {
  const i = list.indexOf(id);
  return { afterId: list[i - 1] ?? null, beforeId: list[i + 1] ?? null };
}

/**
 * Board members as avatars. People who have the board open right now are
 * shown in full colour with a green dot; everyone else is dimmed.
 */
function Presence({ members, viewers }: { members: BoardMember[]; viewers: Viewer[] }) {
  const here = new Set(viewers.map((v) => v.userId));
  const sorted = [...members].sort(
    (a, b) => Number(here.has(b.userId)) - Number(here.has(a.userId)),
  );
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500" aria-live="polite">
        {here.size} here now
      </span>
      <ul className="flex -space-x-2" aria-label="Members">
        {sorted.map((m) => {
          const present = here.has(m.userId);
          return (
            <li
              key={m.userId}
              title={`${m.displayName} (${m.role})${present ? " · here now" : ""}`}
              className={`relative flex size-7 items-center justify-center rounded-full border-2 border-white bg-zinc-200 text-xs font-medium text-zinc-700 dark:border-zinc-950 dark:bg-zinc-700 dark:text-zinc-200 ${present ? "" : "opacity-40"}`}
            >
              {m.displayName.slice(0, 1).toUpperCase()}
              {present && (
                <span
                  className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-zinc-950"
                  aria-hidden
                />
              )}
              <span className="sr-only">{present ? ", here now" : ""}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddColumn({ boardId }: { boardId: string }) {
  const { mutate } = useBoard();
  const [name, setName] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setName(""); // the column appears right away
    const result = await mutate({ type: "create_column", boardId, name: trimmed, id: newId() });
    if (!result.ok) setName(trimmed); // let them retry
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
