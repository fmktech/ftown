// The full v1 property set and its evaluation.
import { evaluate, assertDeclared } from '../core/evaluate.ts';
import { attentionProperties } from '../props/attention.ts';
import { mailProperties } from '../props/mail.ts';
import { restartProperties } from '../props/restart.ts';
import { sessionProperties } from '../props/sessions.ts';
import { treeProperties } from '../props/tree.ts';
import type { Property, Rec } from '../contract.ts';

export const allProperties: readonly Property[] = [...mailProperties, ...attentionProperties, ...treeProperties, ...sessionProperties, ...restartProperties];
assertDeclared(allProperties);

export function judge(log: readonly Rec[]): { verdicts: Extract<Rec, { k: 'verdict' }>[]; exitCode: number } {
  return evaluate(allProperties, log);
}
