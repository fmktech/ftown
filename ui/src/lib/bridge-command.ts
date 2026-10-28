type BridgeCommandOptions = { apiUrl: string; solo?: never } | { solo: true; apiUrl?: never };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Setup copies the launcher, so startup survives removal of the npx cache. */
export function buildBridgeCommand(options: BridgeCommandOptions): string {
  const command = 'npx -y ftown@latest';
  const flags = options.solo ? '--solo' : `--api-url ${shellQuote(options.apiUrl)}`;
  return `${command} setup && "$HOME/.ftown/ftown" ${flags}`;
}
