import { migrateLegacyDataDir } from './ftown-home.js';
import { homedir } from 'node:os';
import { retireBundledAutomationAssets, retireBundledAgentAssets, removeFtownSkill } from './install-ftown-skill.js';
import { readSetupState, writeSetupState } from './setup-state.js';

export interface SetupMigration { id: string; run: () => void }
export const SETUP_MIGRATIONS: readonly SetupMigration[] = [
  { id: 'legacy-cwd-data-v1', run: () => migrateLegacyDataDir() },
  { id: 'retired-factory-loop-assets-v1', run: () => retireBundledAutomationAssets() },
  { id: 'retired-ticket-workflow-assets-v1', run: () => retireBundledAgentAssets() },
  { id: 'retired-split-skills-v1', run: () => {
    for (const name of ['ftown-sessions', 'ftown-loops', 'ftown-orchestrator', 'ftown-workflows']) removeFtownSkill(name);
  } },
];

export function runSetupMigrations(repair = false, migrations: readonly SetupMigration[] = SETUP_MIGRATIONS, home = homedir()): string[] {
  const state = readSetupState(home);
  const completed = new Set(state.completedMigrations);
  const ran: string[] = [];
  for (const migration of migrations) {
    if (!repair && completed.has(migration.id)) continue;
    migration.run(); // A failed migration is deliberately not recorded.
    completed.add(migration.id);
    writeSetupState({ ...state, completedMigrations: [...completed] }, home);
    ran.push(migration.id);
  }
  return ran;
}
