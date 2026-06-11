import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function ftownSkillPath(skillName: string): string {
  return join(homedir(), '.ftown', 'skills', skillName);
}

// Both ~/.agents/skills/<name> and ~/.claude/skills/<name> are exactly two
// levels under $HOME, so the same relative target points to the canonical dir.
function relativeTarget(skillName: string): string {
  return `../../.ftown/skills/${skillName}`;
}

function linkSkillInto(skillsDir: string, skillName: string): void {
  mkdirSync(skillsDir, { recursive: true });
  const linkPath = join(skillsDir, skillName);
  const target = relativeTarget(skillName);

  // lstat instead of existsSync: a dangling symlink must still be detected
  // and replaced, or symlinkSync below throws EEXIST.
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    stat = undefined;
  }

  if (!stat) {
    symlinkSync(target, linkPath);
    console.log(`[Bridge] Linked skill: ${linkPath} -> ${target}`);
    return;
  }

  if (stat.isSymbolicLink()) {
    let current: string | undefined;
    try {
      current = readlinkSync(linkPath);
    } catch {
      /* replace below */
    }
    if (current === target) {
      console.log(`[Bridge] Skill symlink ok: ${linkPath}`);
      return;
    }
    unlinkSync(linkPath);
    symlinkSync(target, linkPath);
    console.log(`[Bridge] Repointed skill link: ${linkPath} -> ${target}`);
    return;
  }

  if (stat.isDirectory()) {
    // Migration from old layout where real skill files lived directly at this path.
    if (existsSync(join(linkPath, 'SKILL.md'))) {
      rmSync(linkPath, { recursive: true, force: true });
      symlinkSync(target, linkPath);
      console.log(`[Bridge] Migrated skill dir to symlink: ${linkPath} -> ${target}`);
    } else {
      console.warn(`[Bridge] ${linkPath} is a directory without SKILL.md; skipping link`);
    }
    return;
  }

  console.warn(`[Bridge] ${linkPath} exists and is not a symlink or directory; skipping link`);
}

/** Copy bundled skill to ~/.ftown/skills/<name> (canonical) and symlink from ~/.agents/skills and ~/.claude/skills. */
export function installFtownSkill(skillName: string, bundledSkillDir: string): void {
  const ftownSkillsDir = join(homedir(), '.ftown', 'skills');
  const dest = ftownSkillPath(skillName);

  mkdirSync(ftownSkillsDir, { recursive: true });
  cpSync(bundledSkillDir, dest, { recursive: true, force: true });

  const scriptsDir = join(dest, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const file of readdirSync(scriptsDir)) {
      chmodSync(join(scriptsDir, file), 0o755);
    }
  }

  console.log(`[Bridge] Installed skill at ${dest}`);

  linkSkillInto(join(homedir(), '.agents', 'skills'), skillName);
  linkSkillInto(join(homedir(), '.claude', 'skills'), skillName);
}
