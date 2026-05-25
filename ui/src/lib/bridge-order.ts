/** Merge saved bridge order with currently known ids; new ids append in stable sort. */
export function mergeBridgeOrder(saved: string[], knownIds: Iterable<string>): string[] {
  const known = new Set(knownIds);
  const kept = saved.filter((id) => known.has(id));
  const missing = [...known]
    .filter((id) => !saved.includes(id))
    .sort((a, b) => a.localeCompare(b));
  return [...kept, ...missing];
}

/** Reorder after drag-drop onto a target row (above/below). */
export function reorderByDrop(
  order: string[],
  draggedId: string,
  targetId: string,
  zone: "above" | "below",
): string[] | null {
  const fromIdx = order.indexOf(draggedId);
  const toIdx = order.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return null;

  const next = order.filter((id) => id !== draggedId);
  let insertIdx = next.indexOf(targetId);
  if (zone === "below") insertIdx += 1;
  next.splice(insertIdx, 0, draggedId);
  return next;
}
