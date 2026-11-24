export function projectDatabaseError(message: string) {
  return /^Unsupported project database version\b/i.test(message);
}

export function ProjectDatabaseUpdate({ bridgeName, onOpenUpdates }: { bridgeName: string; onOpenUpdates?: () => void }) {
  return <p role="alert" className="my-2 flex flex-wrap items-center gap-2">
    <span>A bridge on {bridgeName} is too old to read this project database. Check for an older running copy or update the bridge.</span>
    {onOpenUpdates && <button type="button" className="btn-ghost" onClick={onOpenUpdates}>Bridge updates</button>}
  </p>;
}
