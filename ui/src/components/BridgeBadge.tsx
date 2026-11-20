export interface BridgeIdentity { number: number; name: string }

export function BridgeBadge({ bridge, full = false }: { bridge?: BridgeIdentity; full?: boolean }) {
  if (!bridge) return null;
  return <span className={full ? "bridge-owner bridge-owner-full" : "bridge-owner"}
    aria-label={`Computer #${bridge.number}: ${bridge.name}`} title={bridge.name}>
    <span className="bridge-index">#{bridge.number}</span>
    {full && <span className="bridge-owner-name">{bridge.name}</span>}
  </span>;
}
