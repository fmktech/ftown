/**
 * Stable key identifying a loop group within a bridge. Used for group-level
 * hide/unhide state shared between Dashboard (persistence + badge counts) and
 * LoopList (filtering + hidden-fold entries).
 */
export function loopGroupKey(bridgeId: string, group: string): string {
  return `${bridgeId}::${group}`;
}
