import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const TRANSFER_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export type Inode = { dev: string; ino: string };
export interface StoredReceive {
  endpoint: string;
  destination: string;
  stage: string;
  stageInode?: Inode;
  verified?: { bytes: number; digest: string };
  committing?: { tree: Inode; entries: number; reservation?: Inode };
}

export async function inode(path: string): Promise<Inode> {
  const { dev, ino } = await lstat(path, { bigint: true });
  return { dev: String(dev), ino: String(ino) };
}

export async function matchesInode(path: string, expected: Inode): Promise<boolean> {
  const actual = await inode(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return actual?.dev === expected.dev && actual?.ino === expected.ino;
}

/** One private record per incoming transfer. Only local code writes destination and stage paths. */
export class TransferJournal {
  constructor(private readonly directory: string) {}

  async save(id: string, state: StoredReceive): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const path = join(this.directory, id);
    const file = await open(path + '.tmp', 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(path + '.tmp', path);
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.directory, id), { force: true });
    await rm(join(this.directory, id + '.tmp'), { force: true });
  }

  async entries(): Promise<{ id: string; saved: StoredReceive }[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    const rows = [];
    for (const id of names) {
      if (id.endsWith('.tmp') && TRANSFER_ID.test(id.slice(0, -4))) {
        await rm(join(this.directory, id), { force: true });
      } else if (TRANSFER_ID.test(id)) {
        const saved = JSON.parse(await readFile(join(this.directory, id), 'utf8')) as StoredReceive;
        rows.push({ id, saved });
      }
    }
    return rows;
  }
}
