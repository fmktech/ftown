export interface DraggedSession {
  id: string;
  bridgeId: string;
  hasChildren?: boolean;
}

export type SessionDropZone = "above" | "inside" | "below";
type EdgeDropZone = Exclude<SessionDropZone, "inside">;

export type SessionDropTarget =
  | {
      kind: "session";
      id: string;
      bridgeId: string;
      parentSessionId?: string;
      zone: SessionDropZone;
    }
  | {
      kind: "bridge";
      bridgeId: string;
    };

export type SessionDropAction =
  | {
      type: "set-parent";
      sessionId: string;
      parentSessionId: string | null;
    }
  | {
      type: "reorder";
      sessionId: string;
      targetSessionId: string;
      zone: EdgeDropZone;
      parentSessionId: string | null;
    };

export function getSessionDropZone(offsetY: number, height: number): SessionDropZone {
  if (offsetY < height / 3) return "above";
  if (offsetY > (height * 2) / 3) return "below";
  return "inside";
}

export function resolveSessionDrop(
  dragged: DraggedSession,
  target: SessionDropTarget,
): SessionDropAction | null {
  if (dragged.bridgeId !== target.bridgeId) return null;
  if (target.kind === "bridge") {
    return {
      type: "set-parent",
      sessionId: dragged.id,
      parentSessionId: null,
    };
  }
  if (dragged.id === target.id) return null;
  if (target.zone === "inside" && (dragged.hasChildren || target.parentSessionId)) return null;
  if (target.zone !== "inside") {
    if (dragged.hasChildren && target.parentSessionId) return null;
    return {
      type: "reorder",
      sessionId: dragged.id,
      targetSessionId: target.id,
      zone: target.zone,
      parentSessionId: target.parentSessionId ?? null,
    };
  }
  return {
    type: "set-parent",
    sessionId: dragged.id,
    parentSessionId: target.id,
  };
}
