import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SKILL_NAME = 'ftown-sessions';
const CLAUDE_SYMLINK_TARGET = `../../.agents/skills/${SKILL_NAME}`;

export function agentsSkillPath(): string {
  return join(homedir(), '.agents', 'skills', SKILL_NAME);
}

export function claudeSkillSymlinkPath(): string {
  return join(homedir(), '.claude', 'skills', SKILL_NAME);
}

/** Copy bundled skill into ~/.agents/skills and symlink ~/.claude/skills. */
export function installFtownSessionsSkill(bundledSkillDir: string): void {
  const agentsDir = join(homedir(), '.agents', 'skills');
  const dest = agentsSkillPath();

  mkdirSync(agentsDir, { recursive: true });
  cpSync(bundledSkillDir, dest, { recursive: true, force: true });

  const skillScript = join(dest, 'scripts', 'ftown-sessions');
  if (existsSync(skillScript)) {
    chmodSync(skillScript, 0o755);
  }

  const claudeSkillsDir = join(homedir(), '.claude', 'skills');
  const linkPath = claudeSkillSymlinkPath();
  mkdirSync(claudeSkillsDir, { recursive: true });

  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      try {
        const current = readlinkSync(linkPath);
        if (current === CLAUDE_SYMLINK_TARGET) {
          console.log(`[Bridge] Skill symlink ok: ${linkPath}`);
          return;
        }
      } catch {
        /* replace below */
      }
      unlinkSync(linkPath);
    } else {
      console.warn(
        `[Bridge] ${linkPath} exists and is not a symlink; skipping Claude skill link`,
      );
      console.log(`[Bridge] Installed skill at ${dest}`);
      return;
    }
  }

  symlinkSync(CLAUDE_SYMLINK_TARGET, linkPath);
  console.log(`[Bridge] Installed skill at ${dest}`);
  console.log(`[Bridge] Linked Claude skill: ${linkPath} -> ${CLAUDE_SYMLINK_TARGET}`);
}
