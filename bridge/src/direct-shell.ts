import { win32 } from 'node:path';

/** Preserve command text without ConPTY/Windows argv quoting it a second time. */
export function directShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return {
      file: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(`$ErrorActionPreference = 'Stop'\n${command}\nexit $LASTEXITCODE`, 'utf16le').toString('base64')],
    };
  }
  return { file: '/bin/zsh', args: ['-l', '-c', command] };
}
