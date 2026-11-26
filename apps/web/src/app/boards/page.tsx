import type { Metadata } from "next";
import { BoardList } from "@/components/board-list";

export const metadata: Metadata = { title: "Boards · Collab Board" };

export default function BoardsPage() {
  return <BoardList />;
}
