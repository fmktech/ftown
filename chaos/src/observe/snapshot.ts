// Combine the disk and process observers into the contract's Snapshot.
import { ROLES } from '../contract.ts';
import type { Role, SessionObs, Snapshot } from '../contract.ts';
import { readSessionDisk, readTree } from './disk.ts';
import type { Ids } from './disk.ts';
import { bridgeAlive, procAlive, tmuxAlive } from './procs.ts';
import type { TmuxOpts } from './procs.ts';

export interface SnapshotOpts {
  dataDir: string;
  ids: Ids;
  /** PID of the bridge process, or null when it is not running. */
  bridgePid: number | null;
  /** Caller's unfaulted `ftown sessions list` probe. Not called when the bridge is not alive. */
  bridgeResponsive: () => Promise<boolean>;
  tmux: TmuxOpts;
  /** Test seam: root of the proc filesystem. Default /proc. */
  procRoot?: string;
}

export async function takeSnapshot(opts: SnapshotOpts): Promise<Snapshot> {
  const procOpts = { procRoot: opts.procRoot };
  const alive = await bridgeAlive(opts.bridgePid, procOpts);
  const responsive = alive ? await opts.bridgeResponsive().catch(() => false) : false;
  const sessions: SessionObs[] = await Promise.all(
    ROLES.map(async (role: Role): Promise<SessionObs> => {
      const id = opts.ids[role];
      const [disk, tmux, proc] = await Promise.all([
        readSessionDisk(opts.dataDir, id),
        id === null ? Promise.resolve(false) : tmuxAlive(id, opts.tmux),
        procAlive(role, procOpts),
      ]);
      return { role, status: disk.status, tmuxAlive: tmux, procAlive: proc, inbox: disk.inbox, inboxParses: disk.inboxParses, untaggedWakingMail: disk.untaggedWakingMail, attention: disk.attention, attentionParses: disk.attentionParses };
    }),
  );
  const tree = await readTree(opts.dataDir, opts.ids);
  return { bridgeAlive: alive, bridgeResponsive: responsive === true, sessions, ...tree };
}
