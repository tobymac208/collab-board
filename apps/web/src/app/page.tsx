import { HomeActions } from "@/components/home-actions";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-6 px-8">
      <h1 className="text-4xl font-semibold tracking-tight">Collab Board</h1>
      <p className="max-w-prose text-lg text-zinc-600 dark:text-zinc-400">
        A real-time collaborative kanban board. Create boards, organise cards into columns, drag
        them around, and invite people to work on them with you.
      </p>
      <HomeActions />
    </main>
  );
}
