import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isCliEntry(moduleUrl: string, entry: string | undefined): boolean {
  if (!entry) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(entry)).href; }
  catch { return false; }
}

export async function executeCli(run: () => Promise<number>): Promise<void> {
  try { process.exitCode = await run(); }
  catch (error) {
    console.error(`ftown: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
