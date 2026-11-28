"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  createUndo,
  cursorAt,
  cursorIndex,
  editText,
  onDocUpdate,
  readText,
  type CardTextField,
  type TextCursor,
} from "@collab/shared";
import { LOCAL, type CardDocEntry } from "@/lib/card-docs";

/** What we publish about ourselves in a card's awareness state. */
export interface CursorState {
  user: { name: string; color: string };
  cursor: { field: CardTextField; anchor: TextCursor; head: TextCursor } | null;
}

/** A stable colour per person, so their caret looks the same to everyone. */
export function colorFor(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 45%)`;
}

/**
 * The single edit that turns `before` into `after`: the text between their
 * common prefix and common suffix. Typing, pasting, deleting a selection and
 * autocorrect all come out as one replace.
 */
export function diffText(before: string, after: string) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end++;
  }
  return {
    index: start,
    deleteCount: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * A text input bound to one field of a card's CRDT document.
 *
 * - Typing becomes CRDT edits; other people's edits update the box live,
 *   and your cursor stays next to the same characters while they do.
 * - Undo/redo (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl+Y) only undo your typing.
 * - Your cursor is shared through awareness; everyone else's is drawn on top.
 */
export function CrdtField({
  entry,
  field,
  label,
  multiline = false,
  maxLength,
  placeholder,
  className = "",
}: {
  entry: CardDocEntry;
  field: CardTextField;
  label: string;
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  className?: string;
}) {
  const { doc, awareness } = entry;
  const ref = useRef<FieldElement>(null);
  const [value, setValue] = useState(() => readText(doc, field));
  /** Our selection, anchored to characters rather than offsets. */
  const selection = useRef<{ anchor: TextCursor; head: TextCursor } | null>(null);
  /** A selection to restore after a remote edit re-renders the box. */
  const restore = useRef<{ start: number; end: number } | null>(null);

  // Remote (and local) changes: show the new text; keep our cursor in place.
  useEffect(
    () =>
      onDocUpdate(doc, (_update, origin) => {
        const el = ref.current;
        if (origin !== LOCAL && el && document.activeElement === el && selection.current) {
          const anchor = cursorIndex(doc, field, selection.current.anchor);
          const head = cursorIndex(doc, field, selection.current.head);
          if (anchor !== null && head !== null) {
            restore.current = { start: Math.min(anchor, head), end: Math.max(anchor, head) };
          }
        }
        setValue(readText(doc, field));
      }),
    [doc, field],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && restore.current) {
      el.setSelectionRange(restore.current.start, restore.current.end);
      restore.current = null;
    }
  }, [value]);

  // Undo covers only our own typing in this field.
  const undo = useRef<ReturnType<typeof createUndo> | null>(null);
  useEffect(() => {
    undo.current = createUndo(doc, field, LOCAL);
    return () => undo.current?.destroy();
  }, [doc, field]);

  /** Remembers our selection and shares it as our cursor. */
  function trackSelection() {
    const el = ref.current;
    if (!el || el.selectionStart === null || el.selectionEnd === null) return;
    const backwards = el.selectionDirection === "backward";
    const anchorIndex = backwards ? el.selectionEnd : el.selectionStart;
    const headIndex = backwards ? el.selectionStart : el.selectionEnd;
    selection.current = {
      anchor: cursorAt(doc, field, anchorIndex),
      head: cursorAt(doc, field, headIndex),
    };
    const state = awareness.getLocalState() as CursorState | null;
    if (state) awareness.setLocalState({ ...state, cursor: { field, ...selection.current } });
  }

  function onChange(event: React.ChangeEvent<FieldElement>) {
    const { index, deleteCount, insert } = diffText(readText(doc, field), event.target.value);
    if (deleteCount > 0 || insert) editText(doc, field, index, deleteCount, insert, LOCAL);
    trackSelection();
  }

  function onKeyDown(event: React.KeyboardEvent<FieldElement>) {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "z" || key === "y") {
      event.preventDefault();
      if (key === "y" || event.shiftKey) undo.current?.redo();
      else undo.current?.undo();
    }
  }

  function onBlur() {
    const state = awareness.getLocalState() as CursorState | null;
    if (state?.cursor?.field === field) awareness.setLocalState({ ...state, cursor: null });
  }

  const shared = {
    ref: ref as never,
    "aria-label": label,
    value,
    maxLength,
    placeholder,
    onChange,
    onKeyDown,
    onSelect: trackSelection,
    onFocus: trackSelection,
    onBlur,
    className: `w-full rounded-md border border-zinc-300 bg-white text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${multiline ? "px-3 py-2" : "px-3 py-1.5"} ${className}`,
  };

  return (
    <div className="relative">
      {multiline ? <textarea rows={6} {...shared} /> : <input {...shared} />}
      <RemoteCursors entry={entry} field={field} value={value} target={ref} multiline={multiline} />
    </div>
  );
}

interface RemoteCursor {
  clientId: number;
  name: string;
  color: string;
  start: number;
  end: number;
  head: number;
}

/** Everyone else's cursor in this field, as indexes into the current text. */
function useRemoteCursors(entry: CardDocEntry, field: CardTextField): RemoteCursor[] {
  const { doc, awareness } = entry;
  const [, rerender] = useState(0);
  useEffect(() => {
    const onChange = () => rerender((n) => n + 1);
    awareness.on("change", onChange);
    const stop = onDocUpdate(doc, onChange); // positions move as text changes
    return () => {
      awareness.off("change", onChange);
      stop();
    };
  }, [awareness, doc]);

  const cursors: RemoteCursor[] = [];
  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === doc.clientID) continue;
    const state = raw as Partial<CursorState>;
    if (state.cursor?.field !== field || !state.user) continue;
    const anchor = cursorIndex(doc, field, state.cursor.anchor);
    const head = cursorIndex(doc, field, state.cursor.head);
    if (anchor === null || head === null) continue;
    cursors.push({
      clientId,
      name: state.user.name,
      color: state.user.color,
      start: Math.min(anchor, head),
      end: Math.max(anchor, head),
      head,
    });
  }
  return cursors;
}

/** Style properties that decide where text lands, copied onto the mirror. */
const MIRRORED = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

/**
 * Draws other people's carets and selections over a text box.
 *
 * Text boxes can't style parts of their contents, so this renders an
 * invisible copy of the text ("mirror") with the same font, padding, width
 * and scroll position on top of the box, with carets and highlights placed
 * inside it. It ignores the pointer, so clicks still reach the box.
 */
function RemoteCursors({
  entry,
  field,
  value,
  target,
  multiline,
}: {
  entry: CardDocEntry;
  field: CardTextField;
  value: string;
  target: React.RefObject<FieldElement | null>;
  multiline: boolean;
}) {
  const cursors = useRemoteCursors(entry, field);
  const [, rerender] = useState(0);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const onScroll = () => rerender((n) => n + 1);
    el.addEventListener("scroll", onScroll);
    const resize = new ResizeObserver(onScroll);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [target]);

  const el = target.current;
  if (!el || cursors.length === 0) return null;

  const computed = getComputedStyle(el);
  const mirror: CSSProperties = {};
  for (const key of MIRRORED) (mirror as Record<string, string>)[key] = computed[key];
  // A textarea's scrollbar narrows its text; give the mirror the same width.
  const scrollbar =
    el.offsetWidth -
    el.clientWidth -
    parseFloat(computed.borderLeftWidth) -
    parseFloat(computed.borderRightWidth);

  // Cut the text at every selection edge and caret.
  const cuts = [...new Set([0, value.length, ...cursors.flatMap((c) => [c.start, c.end, c.head])])]
    .filter((i) => i >= 0 && i <= value.length)
    .sort((a, b) => a - b);
  const pieces: React.ReactNode[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const at = cuts[i]!;
    for (const c of cursors.filter((c) => c.head === at)) {
      pieces.push(<Caret key={`caret-${c.clientId}`} cursor={c} />);
    }
    const next = cuts[i + 1];
    if (next === undefined) break;
    const covering = cursors.find((c) => c.start <= at && next <= c.end && c.start !== c.end);
    const text = value.slice(at, next);
    pieces.push(
      covering ? (
        <mark
          key={`sel-${at}`}
          style={{ background: covering.color, opacity: 0.25, color: "transparent" }}
        >
          {text}
        </mark>
      ) : (
        <span key={`txt-${at}`}>{text}</span>
      ),
    );
  }

  return (
    <div
      aria-hidden
      data-cursor-overlay
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ ...mirror, borderColor: "transparent", borderStyle: "solid" }}
    >
      <div
        style={{
          color: "transparent",
          whiteSpace: multiline ? "pre-wrap" : "pre",
          overflowWrap: multiline ? "break-word" : "normal",
          paddingRight: multiline && scrollbar > 0 ? scrollbar : undefined,
          transform: `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`,
        }}
      >
        {pieces}
        {/* A trailing newline needs something after it to take up a line. */}
        {"​"}
      </div>
    </div>
  );
}

function Caret({ cursor }: { cursor: RemoteCursor }) {
  // The name label normally sits above the caret; on the top line that would
  // be clipped by the box, so it flips below.
  const ref = useRef<HTMLSpanElement>(null);
  const [below, setBelow] = useState(false);
  // Re-measures after every render, since the caret moves with the text; the
  // `flip !== below` check stops it from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const caret = ref.current;
    const box = caret?.closest("[data-cursor-overlay]");
    if (!caret || !box) return;
    const roomAbove = caret.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const flip = roomAbove < 16;
    if (flip !== below) setBelow(flip);
  });
  return (
    <span ref={ref} className="relative" style={{ color: cursor.color }}>
      <span
        className="absolute -top-px bottom-0 w-0.5"
        style={{ background: cursor.color, height: "1.2em" }}
      />
      <span
        className={`absolute left-0 whitespace-nowrap rounded px-1 text-[10px] leading-4 font-medium text-white ${below ? "top-[1.3em]" : "bottom-full mb-0.5"}`}
        style={{ background: cursor.color }}
      >
        {cursor.name}
      </span>
    </span>
  );
}
