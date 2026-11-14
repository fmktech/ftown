import { spawn } from 'node:child_process';

export interface ProcResult { code: number | null; stdout: string; stderr: string }

/** Runs a command, capturing output. stdio 'inherit' streams stderr to the user when verbose. */
export function run(cmd: string, args: readonly string[], opts: { input?: NodeJS.ReadableStream; echo?: boolean } = {}): Promise<ProcResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d; });
    child.stderr!.on('data', (d: Buffer) => { stderr += d; if (opts.echo) process.stderr.write(d); });
    if (opts.input && child.stdin) opts.input.pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

export async function mustRun(cmd: string, args: readonly string[], opts: { echo?: boolean } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}):\n${r.stderr.slice(-4000)}`);
  return r.stdout;
}
