export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 210;
export const MAX_SIDEBAR_WIDTH = 520;
export const SIDEBAR_KEYBOARD_STEP = 16;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function sidebarWidthFromDrag(
  startWidth: number,
  startClientX: number,
  currentClientX: number,
): number {
  return clampSidebarWidth(startWidth + currentClientX - startClientX);
}
