import { readFileSync } from 'node:fs';

/**
 * A probe answering "is this bridge running under WSL2?". It is injected into
 * the Solo banner and the session-create path so those behaviours can be
 * unit-tested without a WSL2 kernel (or any /proc filesystem at all).
 */
export type Wsl2Probe = () => boolean;

/** The kernel-release files a WSL2 kernel advertises its identity in. */
export const WSL2_PROC_PATHS = ['/proc/version', '/proc/sys/kernel/osrelease'] as const;

/** Injectable reader so detection tests supply fake kernel contents. */
export type ReadProcFile = (path: string) => string;

/** Microsoft's WSL kernels put "microsoft" (and usually "WSL") in the release. */
const WSL_MARKER = /microsoft|wsl/i;

function defaultReadProcFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Default WSL2 probe. Reads /proc/version then /proc/sys/kernel/osrelease and
 * returns true as soon as either contains the WSL kernel marker. A missing or
 * unreadable file is simply skipped, so native Linux/macOS return false.
 */
export function detectWsl2(readProcFile: ReadProcFile = defaultReadProcFile): boolean {
  return WSL2_PROC_PATHS.some((path) => {
    try {
      return WSL_MARKER.test(readProcFile(path));
    } catch {
      return false;
    }
  });
}

/**
 * True when a workdir sits on a WSL drvfs/9p mount under /mnt (e.g. /mnt/c).
 * These mounts are slow and break inotify-based file watching, so repos should
 * live on the Linux filesystem instead.
 */
export function isUnderWslMnt(workingDir: string): boolean {
  return workingDir.startsWith('/mnt/');
}

/** Warning shown once when a session is launched from a /mnt workdir under WSL2. */
export function wslMntWorkdirWarning(workingDir: string): string {
  return (
    `[Bridge] WSL2: session workdir '${workingDir}' is under /mnt/ (the Windows ` +
    `filesystem mounted over 9p). It is slow and breaks file watching — keep ` +
    `repos on the Linux filesystem (for example under ~/).`
  );
}

export interface SoloBannerLinesOptions {
  /** Non-loopback LAN IPv4 addresses for the banner (ignored under WSL2). */
  ips: string[];
  port: number;
  /** Fresh access key on a first boot / --rotate-key, else undefined. */
  accessKeyRaw?: string;
  isWsl2: boolean;
}

/**
 * Connection lines for the one-time Solo banner, for both a fresh key and the
 * key-already-paired case. Under WSL2 the VM address is not reachable from the
 * LAN, so users are pointed at localhost on Windows and told how to get LAN
 * access instead of being given a misleading VM IP.
 */
export function soloBannerLines({ ips, port, accessKeyRaw, isWsl2 }: SoloBannerLinesOptions): string[] {
  const keyHint = (): string[] =>
    accessKeyRaw ? [] : ['  Key not shown: already issued once. --rotate-key regenerates it.'];

  if (isWsl2) {
    const link = `http://localhost:${port}${accessKeyRaw ? `/#k=${accessKeyRaw}` : '/'}`;
    return [
      `  Open from Windows: ${link}`,
      ...keyHint(),
      '  WSL2: the VM IP is not reachable from other devices on your LAN.',
      `  For LAN access, forward port ${port} from Windows (netsh interface portproxy) or run Solo in Docker.`,
    ];
  }

  const ipLines = ips.map((ip) => {
    const base = `http://${ip}:${port}`;
    return accessKeyRaw
      ? `  Open:   ${base}/#k=${accessKeyRaw}`
      : `  URL:    ${base}  (key already paired — --rotate-key reprints)`;
  });
  return [...ipLines, ...keyHint()];
}
