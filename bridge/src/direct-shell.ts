import { win32 } from 'node:path';

/** Select the platform shell without bypassing policy or encoding command text. */
export function directShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return {
      file: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-Command',
        `$ErrorActionPreference = 'Stop'\n${command}\nexit $LASTEXITCODE`],
    };
  }
  return { file: '/bin/zsh', args: ['-l', '-c', command] };
}
