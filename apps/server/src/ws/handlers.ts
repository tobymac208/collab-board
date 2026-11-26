import type { WebSocket } from "ws";
import type { BoardChangeEvent, ClientRequest, ServerEvent, User } from "@collab/shared";
import type { DB } from "../db/schema.ts";
import * as store from "../boards/store.ts";
import type { Hub } from "./hub.ts";

export interface RequestContext {
  db: DB;
  hub: Hub;
  user: User;
  /** The requesting socket. Broadcasts skip it: it gets the reply instead. */
  socket: WebSocket;
}

/**
 * Executes one client request, broadcasts its effects to everyone else who
 * should see them, and returns the events to send back to the requester.
 */
export async function handleRequest(
  ctx: RequestContext,
  msg: ClientRequest,
): Promise<ServerEvent[]> {
  const { db, hub, socket } = ctx;
  const uid = ctx.user.id;

  /** A board change: everyone else viewing the board gets it too. */
  const boardChange = (boardId: string, event: BoardChangeEvent): ServerEvent[] => {
    hub.toBoard(boardId, event, socket);
    return [event];
  };

  switch (msg.type) {
    case "list_boards":
      return [{ type: "board_list", boards: await store.listBoards(db, uid) }];

    case "create_board": {
      const { value: board, revision } = await store.createBoard(db, uid, msg.name);
      const event: ServerEvent = { type: "board_upserted", board, revision };
      hub.toUser(uid, event, socket); // the creator's other tabs
      return [event];
    }

    case "rename_board": {
      const { value: name, revision } = await store.renameBoard(db, uid, msg.boardId, msg.name);
      // Board lists and open boards alike; each member sees their own role.
      for (const member of await store.listMemberRoles(db, msg.boardId)) {
        hub.toUser(
          member.userId,
          {
            type: "board_upserted",
            board: { id: msg.boardId, name, role: member.role },
            revision,
          },
          socket,
        );
      }
      return [
        {
          type: "board_upserted",
          board: { id: msg.boardId, name, role: "owner" }, // only owners can rename
          revision,
        },
      ];
    }

    case "delete_board": {
      const members = await store.deleteBoard(db, uid, msg.boardId);
      const event: ServerEvent = { type: "board_deleted", boardId: msg.boardId };
      for (const memberId of members) hub.toUser(memberId, event, socket);
      hub.dropBoard(msg.boardId);
      return [event];
    }

    case "open_board": {
      // Check access, then subscribe, then read. Subscribing before the read
      // means no change can slip between the snapshot and the subscription;
      // any change that lands in that window arrives as an event the client
      // can recognise as already included by its revision.
      await store.requireAccess(db, uid, msg.boardId);
      hub.open(socket, msg.boardId);
      try {
        const snapshot = await store.getBoardSnapshot(db, uid, msg.boardId);
        return [{ type: "board_snapshot", ...snapshot }];
      } catch (err) {
        hub.close(socket, msg.boardId);
        throw err;
      }
    }

    case "close_board":
      hub.close(socket, msg.boardId);
      return [];

    case "add_member": {
      const { value, revision } = await store.addMember(db, uid, msg.boardId, msg.email);
      // The new member's board list gains the board.
      hub.toUser(value.member.userId, {
        type: "board_upserted",
        board: { id: msg.boardId, name: value.boardName, role: value.member.role },
        revision,
      });
      return boardChange(msg.boardId, {
        type: "member_added",
        boardId: msg.boardId,
        member: value.member,
        revision,
      });
    }

    case "create_column": {
      const r = await store.createColumn(db, uid, msg.boardId, msg.name);
      return boardChange(r.boardId, {
        type: "column_upserted",
        column: r.value,
        revision: r.revision,
      });
    }
    case "rename_column": {
      const r = await store.renameColumn(db, uid, msg.columnId, msg.name);
      return boardChange(r.boardId, {
        type: "column_upserted",
        column: r.value,
        revision: r.revision,
      });
    }
    case "move_column": {
      const r = await store.moveColumn(db, uid, msg.columnId, msg.toIndex);
      return boardChange(r.boardId, {
        type: "column_upserted",
        column: r.value,
        revision: r.revision,
      });
    }
    case "delete_column": {
      const r = await store.deleteColumn(db, uid, msg.columnId);
      return boardChange(r.boardId, {
        type: "column_deleted",
        boardId: r.boardId,
        columnId: r.value.id,
        revision: r.revision,
      });
    }

    case "create_card": {
      const r = await store.createCard(db, uid, msg.columnId, msg.title);
      return boardChange(r.boardId, { type: "card_upserted", card: r.value, revision: r.revision });
    }
    case "update_card": {
      const r = await store.updateCard(db, uid, msg.cardId, {
        title: msg.title,
        description: msg.description,
      });
      return boardChange(r.boardId, { type: "card_upserted", card: r.value, revision: r.revision });
    }
    case "move_card": {
      const r = await store.moveCard(db, uid, msg.cardId, msg.toColumnId, msg.toIndex);
      return boardChange(r.boardId, { type: "card_upserted", card: r.value, revision: r.revision });
    }
    case "delete_card": {
      const r = await store.deleteCard(db, uid, msg.cardId);
      return boardChange(r.boardId, {
        type: "card_deleted",
        boardId: r.boardId,
        cardId: r.value.id,
        revision: r.revision,
      });
    }
  }
}
