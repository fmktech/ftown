import { describe, expect, it } from 'vitest';

import { buildChildBriefing, parseCreateSessionBody } from './create-ftown-session.js';

// FIX C: ftown-workflows children must be spawnable WITHOUT the standard child briefing,
// because that briefing tells the child to report via mail — which conflicts with the
// file-based result protocol the workflow runner polls for. The flag is carried on the
// create-session body and parsed here.
describe('parseCreateSessionBody — suppressBriefing plumbing', () => {
  it('parses suppressBriefing: true', () => {
    expect(parseCreateSessionBody({ suppressBriefing: true }).suppressBriefing).toBe(true);
  });

  it('defaults suppressBriefing to false when absent', () => {
    expect(parseCreateSessionBody({ prompt: 'do x' }).suppressBriefing).toBe(false);
  });

  it('only accepts the strict boolean true (not truthy strings)', () => {
    expect(parseCreateSessionBody({ suppressBriefing: 'yes' }).suppressBriefing).toBe(false);
    expect(parseCreateSessionBody({ suppressBriefing: 1 }).suppressBriefing).toBe(false);
  });

  it('still passes through the other create fields', () => {
    const input = parseCreateSessionBody({ prompt: 'do x', shellType: 'claude', suppressBriefing: true });
    expect(input.prompt).toBe('do x');
    expect(input.shellType).toBe('claude');
    expect(input.suppressBriefing).toBe(true);
  });
});

// Sanity: the standard briefing genuinely instructs mail-based reporting — which is
// exactly what we suppress for workflow children. If this ever changes, the suppression
// rationale should be revisited.
describe('buildChildBriefing', () => {
  it('instructs the child to report via ftown-harness mail (the conflicting channel)', () => {
    const briefing = buildChildBriefing({
      childName: 'worker',
      childId: 'c1',
      parentName: 'orch',
      parentId: 'p1',
    });
    expect(briefing).toContain('mail send --parent');
  });
});
