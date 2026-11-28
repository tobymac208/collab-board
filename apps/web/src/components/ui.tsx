"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ButtonProps = React.ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

const variants = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
  secondary:
    "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
  ghost:
    "text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${className}`}
    />
  );
}

export function Textarea({ className = "", ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${className}`}
    />
  );
}

/**
 * Text that turns into an input on click. Commits on Enter or blur, cancels
 * on Escape. Empty or unchanged values are discarded.
 */
export function InlineEdit({
  value,
  onSave,
  label,
  maxLength,
  disabled = false,
  className = "",
}: {
  value: string;
  onSave: (next: string) => void;
  label: string;
  maxLength?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing || disabled) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title={disabled ? undefined : `Rename ${label}`}
        className={`min-w-0 truncate rounded px-1 text-left enabled:hover:bg-zinc-200/70 dark:enabled:hover:bg-zinc-800 ${className}`}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
  };

  return (
    <input
      ref={inputRef}
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className={`min-w-0 rounded border border-blue-500 bg-white px-1 outline-none dark:bg-zinc-900 ${className}`}
    />
  );
}

/** A modal built on the native <dialog> element (focus trapping and Escape for free). */
export function Modal({
  open,
  onClose,
  title,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: "sm" | "md";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Opening focuses the first focusable element by default; let content
      // pick a safer one (e.g. Cancel on a destructive confirmation).
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // backdrop click
      }}
      className={`m-auto w-full ${size === "sm" ? "max-w-sm" : "max-w-lg"} rounded-lg bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100`}
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <h2 className="text-lg font-semibold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  message: React.ReactNode;
  /** Label for the confirming button, e.g. "Delete column". */
  confirmLabel: string;
  /** Style the confirming button as destructive. */
  danger?: boolean;
}

/**
 * An in-app replacement for `window.confirm`. Returns a `confirm` function
 * that opens the dialog and resolves to whether the person confirmed, plus
 * the dialog element to render somewhere in the component:
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (await confirm({ title: "Delete?", message: "…", confirmLabel: "Delete", danger: true })) …
 *   return <>…{confirmDialog}</>;
 *
 * Escape, the backdrop and Cancel all count as "no". Cancel has focus first,
 * so pressing Enter by reflex doesn't delete anything.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [request, setRequest] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );

  const answer = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  const dialog = (
    <Modal
      open={request !== null}
      onClose={() => answer(false)}
      title={request?.title ?? ""}
      size="sm"
    >
      <div className="text-sm text-zinc-600 dark:text-zinc-400">{request?.message}</div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" data-autofocus onClick={() => answer(false)}>
          Cancel
        </Button>
        <Button variant={request?.danger ? "danger" : "primary"} onClick={() => answer(true)}>
          {request?.confirmLabel}
        </Button>
      </div>
    </Modal>
  );

  return [confirm, dialog];
}
