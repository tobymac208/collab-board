"use client";

import { useState } from "react";
import { LIMITS, type BoardMember } from "@collab/shared";
import { useRequest } from "@/lib/sync";
import { Button, Input, Modal } from "../ui";

export function ShareDialog({
  open,
  onClose,
  boardId,
  members,
  isOwner,
}: {
  open: boolean;
  onClose: () => void;
  boardId: string;
  members: BoardMember[];
  isOwner: boolean;
}) {
  const request = useRequest();
  const [email, setEmail] = useState("");

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (await request({ type: "add_member", boardId, email: trimmed })) setEmail("");
  }

  return (
    <Modal open={open} onClose={onClose} title={isOwner ? "Share board" : "Members"}>
      <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between py-2 text-sm">
            <span>
              {m.displayName} <span className="text-zinc-500">· {m.email}</span>
            </span>
            <span className="text-xs text-zinc-500">{m.role === "owner" ? "Owner" : "Editor"}</span>
          </li>
        ))}
      </ul>
      {isOwner && (
        <form onSubmit={add} className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="share-email">
            Invite by email
          </label>
          <div className="flex gap-2">
            <Input
              id="share-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              maxLength={LIMITS.email}
            />
            <Button type="submit" disabled={!email.trim()}>
              Add
            </Button>
          </div>
          <p className="text-xs text-zinc-500">
            They need an account first. Editors can change columns and cards.
          </p>
        </form>
      )}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
