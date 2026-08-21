/**
 * Update one hierarchy level so only its active section is expanded. Fold
 * state belonging to other hierarchy levels is intentionally preserved.
 */
export function collapseToActiveSection(
  current: ReadonlySet<string>,
  controlledSectionIds: readonly string[],
  activeSectionId: string | null,
): Set<string> {
  const next = new Set(current);
  for (const sectionId of controlledSectionIds) {
    if (sectionId === activeSectionId) next.delete(sectionId);
    else next.add(sectionId);
  }
  return next;
}
