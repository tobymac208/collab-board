"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LIMITS, type BoardSummary } from "@collab/shared";
import { useOnConnected, useRequest, useServerEvents } from "@/lib/sync";
import { Button, Input, useConfirm } from "./ui";

export function BoardList() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const request = useRequest();
  const router = useRouter();

  useOnConnected(() => void request({ type: "list_boards" }));

  useServerEvents((event) => {
    switch (event.type) {
      case "board_list":
        setBoards(event.boards);
        break;
      case "board_upserted":
        setBoards((list) => {
          if (!list) return list;
          const exists = list.some((b) => b.id === event.board.id);
          return exists
            ? list.map((b) => (b.id === event.board.id ? event.board : b))
            : [...list, event.board];
        });
        break;
      case "board_deleted":
        setBoards((list) => list && list.filter((b) => b.id !== event.boardId));
        break;
    }
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const events = await request({ type: "create_board", name: trimmed });
    setCreating(false);
    const created = events?.find((e) => e.type === "board_upserted");
    if (created) {
      setName("");
      router.push(`/boards/${created.board.id}`);
    }
  }

  const [confirm, confirmDialog] = useConfirm();

  async function remove(board: BoardSummary) {
    const ok = await confirm({
      title: "Delete board?",
      message: (
        <>
          <strong>{board.name}</strong> and all its columns and cards will be deleted for everyone.
          This can&apos;t be undone.
        </>
      ),
      confirmLabel: "Delete board",
      danger: true,
    });
    if (ok) await request({ type: "delete_board", boardId: board.id });
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Your boards</h1>

      <form onSubmit={create} className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New board name"
          aria-label="New board name"
          maxLength={LIMITS.boardName}
        />
        <Button type="submit" disabled={creating || !name.trim()}>
          Create board
        </Button>
      </form>

      {boards === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="text-sm text-zinc-500">No boards yet. Create your first one above.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {boards.map((board) => (
            <li
              key={board.id}
              className="group relative flex items-center rounded-lg border border-zinc-200 bg-white transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
            >
              <Link href={`/boards/${board.id}`} className="flex flex-1 flex-col gap-1 p-4">
                <span className="font-medium">{board.name}</span>
                <span className="text-xs text-zinc-500">
                  {board.role === "owner" ? "Owner" : "Editor"}
                </span>
              </Link>
              {board.role === "owner" && (
                <Button
                  variant="ghost"
                  className="mr-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => void remove(board)}
                  aria-label={`Delete ${board.name}`}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </main>
  );
}
