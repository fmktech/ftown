import { createHash } from 'node:crypto';
import type { Rec } from '../contract.ts';

/** Top-level key order per record kind: the order declared in the contract's Rec union. */
const TOP_ORDER: Readonly<Record<Rec['k'], readonly string[]>> = {
  run: ['k', 'seed', 'level', 'profile', 'contract'],
  schedule: ['k', 'faults'],
  fault: ['k', 't', 'id', 'phase', 'kind', 'target', 'ok'],
  op: ['k', 't', 'op', 'ok', 'error'],
  agent: ['k', 't', 'role', 'e'],
  checkpoint: ['k', 't', 'name', 'final', 'snap'],
  verdict: ['k', 'prop', 'kind', 'status', 'evidence'],
};

/** Nested values: objects with alphabetically sorted keys, arrays in order, no whitespace. */
function nested(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isInteger(v)) throw new Error(`canon: non-integer number ${v}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => nested(x === undefined ? null : x)).join(',')}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error('canon: only plain objects are allowed');
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${nested(o[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canon: unsupported value of type ${typeof v}`);
  }
}

export function encodeRec(rec: Rec): string {
  const order = Object.hasOwn(TOP_ORDER, rec?.k) ? TOP_ORDER[rec.k] : undefined;
  if (order === undefined) throw new Error(`canon: unknown record kind ${String((rec as { k: unknown } | null)?.k)}`);
  const o = rec as unknown as Record<string, unknown>;
  const extra = Object.keys(o)
    .filter((k) => !order.includes(k) && o[k] !== undefined)
    .sort();
  const keys = [...order.filter((k) => o[k] !== undefined), ...extra];
  return `{${keys.map((k) => `${JSON.stringify(k)}:${nested(o[k])}`).join(',')}}`;
}

export function encodeLog(recs: readonly Rec[]): string {
  return recs.map((r) => `${encodeRec(r)}\n`).join('');
}

export function hashLog(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function decodeLog(text: string): Rec[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new Error('canon: log must end with a newline');
  const lines = text.slice(0, -1).split('\n');
  return lines.map((line, i) => {
    if (line === '') throw new Error(`canon: blank line at ${i + 1}`);
    return JSON.parse(line) as Rec;
  });
}
