type BridgeCommandOptions = { apiUrl: string; solo?: never } | { solo: true; apiUrl?: never };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bridgeFlags(options: BridgeCommandOptions): string {
  return options.solo ? '--solo' : `--api-url ${shellQuote(options.apiUrl)}`;
}

/** Setup copies the launcher, so startup survives removal of the npx cache. */
export function buildBridgeCommand(options: BridgeCommandOptions): string {
  const command = 'npx -y ftown@latest';
  return `${command} setup && "$HOME/.ftown/ftown" ${bridgeFlags(options)}`;
}

/** The installed `ftown start` launch is the one the bridge can update in place. */
export function buildBridgeStartCommand(options: BridgeCommandOptions): string {
  return `ftown start ${bridgeFlags(options)}`;
}
