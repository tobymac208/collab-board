import type { ClientRequest, ServerEvent, User } from "@collab/shared";
import type { DB } from "../db/schema.ts";
import * as store from "../boards/store.ts";

/**
 * Executes one client request and returns the state events describing its
 * result. The caller sends these to the requester and then acks. In phase 2
 * the same events get broadcast to everyone else viewing the board.
 */
export async function handleRequest(
  db: DB,
  user: User,
  msg: ClientRequest,
): Promise<ServerEvent[]> {
  const uid = user.id;
  switch (msg.type) {
    case "list_boards":
      return [{ type: "board_list", boards: await store.listBoards(db, uid) }];
    case "create_board":
      return [{ type: "board_upserted", board: await store.createBoard(db, uid, msg.name) }];
    case "rename_board":
      return [
        { type: "board_upserted", board: await store.renameBoard(db, uid, msg.boardId, msg.name) },
      ];
    case "delete_board":
      await store.deleteBoard(db, uid, msg.boardId);
      return [{ type: "board_deleted", boardId: msg.boardId }];
    case "open_board":
      return [{ type: "board_snapshot", ...(await store.getBoardSnapshot(db, uid, msg.boardId)) }];
    case "add_member":
      return [
        {
          type: "member_added",
          boardId: msg.boardId,
          member: await store.addMember(db, uid, msg.boardId, msg.email),
        },
      ];

    case "create_column":
      return [
        {
          type: "column_upserted",
          column: await store.createColumn(db, uid, msg.boardId, msg.name),
        },
      ];
    case "rename_column":
      return [
        {
          type: "column_upserted",
          column: await store.renameColumn(db, uid, msg.columnId, msg.name),
        },
      ];
    case "move_column":
      return [
        {
          type: "column_upserted",
          column: await store.moveColumn(db, uid, msg.columnId, msg.toIndex),
        },
      ];
    case "delete_column": {
      const column = await store.deleteColumn(db, uid, msg.columnId);
      return [{ type: "column_deleted", boardId: column.boardId, columnId: column.id }];
    }

    case "create_card":
      return [
        { type: "card_upserted", card: await store.createCard(db, uid, msg.columnId, msg.title) },
      ];
    case "update_card":
      return [
        {
          type: "card_upserted",
          card: await store.updateCard(db, uid, msg.cardId, {
            title: msg.title,
            description: msg.description,
          }),
        },
      ];
    case "move_card":
      return [
        {
          type: "card_upserted",
          card: await store.moveCard(db, uid, msg.cardId, msg.toColumnId, msg.toIndex),
        },
      ];
    case "delete_card": {
      const card = await store.deleteCard(db, uid, msg.cardId);
      return [{ type: "card_deleted", boardId: card.boardId, cardId: card.id }];
    }
  }
}
