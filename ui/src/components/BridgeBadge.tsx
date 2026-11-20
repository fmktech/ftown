export interface BridgeIdentity { number: number; name: string }

export function bridgeLetter(number: number): string {
  let label = "";
  for (let index = number; index > 0; index = Math.floor((index - 1) / 26)) {
    label = String.fromCharCode(65 + (index - 1) % 26) + label;
  }
  return label;
}

export function BridgeBadge({ bridge, full = false }: { bridge?: BridgeIdentity; full?: boolean }) {
  if (!bridge) return null;
  const letter = bridgeLetter(bridge.number);
  return <span className={full ? "bridge-owner bridge-owner-full" : "bridge-owner"}
    aria-label={`Computer ${letter}: ${bridge.name}`} title={bridge.name}>
    <span className="bridge-index">{letter}</span>
    {full && <span className="bridge-owner-name">{bridge.name}</span>}
  </span>;
}
