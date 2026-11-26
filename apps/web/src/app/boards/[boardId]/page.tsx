import { Suspense } from "react";
import { BoardView } from "@/components/board/board-view";

export default function BoardPage({ params }: PageProps<"/boards/[boardId]">) {
  return (
    <Suspense fallback={null}>
      {params.then(({ boardId }) => (
        <BoardView key={boardId} boardId={boardId} />
      ))}
    </Suspense>
  );
}
