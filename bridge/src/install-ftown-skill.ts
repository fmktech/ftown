import { createHash } from 'node:crypto';
import { RETIRED_FACTORY_ASSETS, RETIRED_LOOP_REFERENCE_SHA256, RETIRED_FTICKET_ASSETS, RETIRED_WORKFLOW_SKILL_ASSETS, RETIRED_WORKFLOW_RUNTIME_ASSETS } from './retired-skill-assets.js';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
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

function realDirectory(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { preserveUnknown(error); return false; }
}

function ownedSkillParentIsReal(): boolean {
  return realDirectory(join(homedir(), '.ftown')) && realDirectory(join(homedir(), '.ftown', 'skills'));
}

function removeSkillLinkFrom(skillsDir: string, skillName: string): void {
  if (!realDirectory(join(skillsDir, '..')) || !realDirectory(skillsDir)) return;
  const linkPath = join(skillsDir, skillName);
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch (error) {
    preserveUnknown(error); return;
  }

  if (stat.isSymbolicLink()) {
    let current: string | undefined;
    try {
      current = readlinkSync(linkPath);
    } catch {
      current = undefined;
    }
    if (current === relativeTarget(skillName)) {
      unlinkSync(linkPath);
      console.log(`[Bridge] Removed stale skill link: ${linkPath}`);
    }
    return;
  }


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

  writeFileSync(join(dest, '.ftown-owned-assets.json'), JSON.stringify(treeSignatures(bundledSkillDir)) + '\n');
  console.log(`[Bridge] Installed skill at ${dest}`);

  linkSkillInto(join(homedir(), '.agents', 'skills'), skillName);
  linkSkillInto(join(homedir(), '.claude', 'skills'), skillName);
}

/** Remove a bridge-owned skill from the canonical store and known agent skill link dirs. */
export function removeFtownSkill(skillName: string): void {
  const dest = ftownSkillPath(skillName);
  const manifest = join(dest, '.ftown-owned-assets.json');
  try {
    const expected = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, string>;
    if (ownedSkillParentIsReal() && matchesTree(dest, expected)) rmSync(dest, { recursive: true, force: true });
  } catch (error) { preserveUnknown(error); /* Unrecognized/customized directories are user-owned. */ }
  // Preserve the discovery links when an unrecognized/customized tree survives.
  if (!pathExists(dest) && ownedSkillParentIsReal()) {
    removeSkillLinkFrom(join(homedir(), '.agents', 'skills'), skillName);
    removeSkillLinkFrom(join(homedir(), '.claude', 'skills'), skillName);
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeSignatures(root: string, prefix = ''): Record<string, string> {
  // Never follow symlinks into user-owned directories.
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Not an owned directory');
  const entries: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    if (!prefix && name === '.ftown-owned-assets.json') continue;
    const path = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Unrecognized symlink');
    if (stat.isDirectory()) {
      entries[rel] = 'directory';
      Object.assign(entries, treeSignatures(path, rel));
    } else if (stat.isFile()) entries[rel] = sha256(path);
    else throw new Error('Unrecognized asset');
  }
  return entries;
}

function matchesTree(root: string, expected: Readonly<Record<string, string>>): boolean {
  const actual = treeSignatures(root);
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every((key) => actual[key] === expected[key]);
}

/** Retire only exact bridge links or byte-for-byte known shipped copies. */
export function retireBundledAutomationAssets(
  known: { factory: Readonly<Record<string, string>>; loopReference: string } = {
    factory: RETIRED_FACTORY_ASSETS, loopReference: RETIRED_LOOP_REFERENCE_SHA256,
  },
): void {
  const dest = ftownSkillPath('factory');
  try {
    if (ownedSkillParentIsReal() && matchesTree(dest, known.factory)) rmSync(dest, { recursive: true });
  } catch (error) { preserveUnknown(error); /* Missing, customized or unrecognized contents must survive. */ }
  for (const dir of ['.agents', '.claude']) {
    const skills = join(homedir(), dir, 'skills');
    // Older bridge versions copied real directories into these locations.
    // Recognize them by the same complete immutable shipped-tree inventory.
    try {
      const path = join(skills, 'factory');
      if (realDirectory(join(homedir(), dir)) && realDirectory(skills)
        && matchesTree(path, known.factory)) rmSync(path, { recursive: true });
    } catch (error) { preserveUnknown(error); /* Preserve custom trees, foreign links and symlink parents. */ }
    if (ownedSkillParentIsReal() && !pathExists(dest)) removeSkillLinkFrom(skills, 'factory');
  }

  const references = join(ftownSkillPath('ftown'), 'references');
  const reference = join(references, 'loops.md');
  try {
    // The parents must also be real directories, never arbitrary symlink targets.
    if (!ownedSkillParentIsReal() || lstatSync(ftownSkillPath('ftown')).isSymbolicLink() || lstatSync(references).isSymbolicLink()) return;
    if (lstatSync(reference).isFile() && !lstatSync(reference).isSymbolicLink()
      && sha256(reference) === known.loopReference) unlinkSync(reference);
  } catch (error) { preserveUnknown(error); /* Preserve customized/unrecognized paths. */ }
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { preserveUnknown(error); return false; }
}

/** Upgrade retirement never follows symlinks or removes user workflow run data. */
export function retireBundledAgentAssets(
  known: {
    fticket: Readonly<Record<string, string>>;
    skillFiles: Readonly<Record<string, string>>;
    runtimeFiles: Readonly<Record<string, string>>;
  } = {
    fticket: RETIRED_FTICKET_ASSETS,
    skillFiles: RETIRED_WORKFLOW_SKILL_ASSETS,
    runtimeFiles: RETIRED_WORKFLOW_RUNTIME_ASSETS,
  },
): void {
  const home = homedir();
  const canonical = ftownSkillPath('fticket');
  if (ownedSkillParentIsReal()) {
    try {
      if (matchesTree(canonical, known.fticket)) rmSync(canonical, { recursive: true });
    } catch (error) { preserveUnknown(error); /* Missing or customized assets survive. */ }
  }
  for (const agentDir of ['.agents', '.claude']) {
    const skillsDir = join(home, agentDir, 'skills');
    if (!realDirectory(join(home, agentDir)) || !realDirectory(skillsDir)) continue;
    const legacy = join(skillsDir, 'fticket');
    try {
      if (matchesTree(legacy, known.fticket)) rmSync(legacy, { recursive: true });
    } catch (error) { preserveUnknown(error); /* Foreign links and customized trees survive. */ }
    if (ownedSkillParentIsReal() && !pathExists(canonical)) removeSkillLinkFrom(skillsDir, 'fticket');
  }

  const skill = ftownSkillPath('ftown');
  if (ownedSkillParentIsReal() && realDirectory(skill)) {
    for (const [relative, hash] of Object.entries(known.skillFiles)) {
      // Inventory keys are fixed shipped references/examples, never user input.
      const path = join(skill, relative);
      if (realDirectory(join(skill, relative.split('/')[0]))) removeKnownFile(path, hash);
    }
  }

  const ftown = join(home, '.ftown');
  if (!realDirectory(ftown)) return;
  for (const [relative, hash] of Object.entries(known.runtimeFiles)) {
    removeKnownFile(join(ftown, relative), hash);
  }
  const launcher = join(ftown, 'ftown-workflows');
  const expected = `#!/usr/bin/env bash
set -euo pipefail
exec node "${join(ftown, 'ftown-workflows-cli.js')}" "$@"
`;
  try {
    const stat = lstatSync(launcher);
    if (stat.isFile() && !stat.isSymbolicLink() && readFileSync(launcher, 'utf8') === expected) unlinkSync(launcher);
  } catch (error) { preserveUnknown(error); /* Missing or user-owned launcher. */ }
}

function removeKnownFile(path: string, expectedHash: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink() && sha256(path) === expectedHash) unlinkSync(path);
  } catch (error) { preserveUnknown(error); /* Missing, custom and symlink assets survive. */ }
}

/** Unknown/custom contents are a safe skip; filesystem failure must be retryable. */
function preserveUnknown(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
}
