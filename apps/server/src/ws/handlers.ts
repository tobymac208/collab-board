import type { WebSocket } from "ws";
import type { ClientRequest, ServerEvent, User } from "@collab/shared";
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

  /**
   * Replies with a board write's event and, unless this was a resend of a
   * change already applied (and already broadcast), tells everyone else
   * viewing the board.
   */
  const boardChange = (write: store.BoardWrite<unknown>): ServerEvent[] => {
    if (!write.replayed) hub.toBoard(write.boardId, write.event, socket);
    return [write.event];
  };

  switch (msg.type) {
    case "list_boards":
      return [{ type: "board_list", boards: await store.listBoards(db, uid) }];

    case "create_board": {
      const { board, revision } = await store.createBoard(db, uid, msg.name);
      const event: ServerEvent = { type: "board_upserted", board, revision };
      hub.toUser(uid, event, socket); // the creator's other tabs
      return [event];
    }

    case "rename_board": {
      const write = await store.renameBoard(
        db,
        { userId: uid, opId: msg.opId },
        msg.boardId,
        msg.name,
      );
      if (!write.replayed) {
        // Board lists and open boards alike; each member sees their own role.
        for (const member of write.value.members) {
          hub.toUser(
            member.userId,
            {
              type: "board_upserted",
              board: { id: msg.boardId, name: msg.name, role: member.role },
              revision: write.revision,
            },
            socket,
          );
        }
      }
      return [write.event]; // the owner's own view; only owners can rename
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
      // means no change can slip between the reply and the subscription; a
      // change that lands in that window arrives as an event the client
      // recognises as already included by its revision.
      await store.requireAccess(db, uid, msg.boardId);
      hub.open(socket, msg.boardId);
      try {
        // A client that already has the board at some revision gets just the
        // changes since, if the log still has them all.
        if (msg.sinceRevision !== undefined) {
          const changes = await store.getChangesSince(db, uid, msg.boardId, msg.sinceRevision);
          if (changes) return changes;
        }
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

    case "focus_card":
      // Presence only: no data changes. Ignored unless this socket has the
      // board open, so it can't announce cards on boards it isn't viewing.
      hub.focus(socket, msg.boardId, msg.cardId);
      return [];

    case "add_member": {
      const write = await store.addMember(db, { userId: uid }, msg.boardId, msg.email);
      if (!write.replayed) {
        // The new member's board list gains the board.
        hub.toUser(write.value.member.userId, {
          type: "board_upserted",
          board: { id: msg.boardId, name: write.value.boardName, role: write.value.member.role },
          revision: write.revision,
        });
      }
      return boardChange(write);
    }

    case "create_column":
      return boardChange(await store.createColumn(db, actorOf(msg), msg.boardId, msg.name, msg.id));
    case "rename_column":
      return boardChange(await store.renameColumn(db, actorOf(msg), msg.columnId, msg.name));
    case "move_column":
      return boardChange(
        await store.moveColumn(db, actorOf(msg), msg.columnId, msg.afterId, msg.beforeId),
      );
    case "delete_column":
      return boardChange(await store.deleteColumn(db, actorOf(msg), msg.columnId));

    case "create_card":
      return boardChange(await store.createCard(db, actorOf(msg), msg.columnId, msg.title, msg.id));
    case "update_card":
      return boardChange(
        await store.updateCard(db, actorOf(msg), msg.cardId, {
          ...(msg.title ? { title: msg.title } : {}),
          ...(msg.description ? { description: msg.description } : {}),
        }),
      );
    case "move_card":
      return boardChange(
        await store.moveCard(
          db,
          actorOf(msg),
          msg.cardId,
          msg.toColumnId,
          msg.afterId,
          msg.beforeId,
        ),
      );
    case "delete_card":
      return boardChange(await store.deleteCard(db, actorOf(msg), msg.cardId));
  }

  function actorOf(op: { opId: string }): store.Actor {
    return { userId: uid, opId: op.opId };
  }
}
