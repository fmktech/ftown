import { EXIT, PROPERTY_IDS, type PropResult, type PropStatus, type Property, type Rec } from '../contract.ts';

type Verdict = Extract<Rec, { k: 'verdict' }>;

const VALID: Readonly<Record<Property['kind'], readonly PropStatus[]>> = {
  always: ['pass', 'violated', 'unexercised'],
  unreachable: ['pass', 'violated'],
  sometimes: ['hit', 'not_hit'],
};

function run(p: Property, log: readonly Rec[]): PropResult {
  let r: PropResult;
  try {
    r = p.check(log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'violated', evidence: [`property threw: ${msg}`] };
  }
  if (!VALID[p.kind].includes(r.status)) {
    return { status: 'violated', evidence: [`property returned status ${String(r.status)} invalid for kind ${p.kind}`] };
  }
  return r;
}

export function evaluate(
  props: readonly Property[],
  log: readonly Rec[],
): { verdicts: Verdict[]; exitCode: number } {
  const input = log.filter((r) => r.k !== 'verdict');
  const verdicts: Verdict[] = props.map((p) => {
    const r = run(p, input);
    return { k: 'verdict', prop: p.id, kind: p.kind, status: r.status, evidence: [...r.evidence] };
  });
  const bad = verdicts.some(
    (v) =>
      (v.kind === 'always' && (v.status === 'violated' || v.status === 'unexercised')) ||
      (v.kind === 'unreachable' && v.status === 'violated'),
  );
  return { verdicts, exitCode: bad ? EXIT.violation : EXIT.ok };
}

/** Throws unless the ids equal PROPERTY_IDS exactly: nothing missing, nothing extra, no duplicates. */
export function assertDeclared(props: readonly Property[]): void {
  const ids = props.map((p) => p.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0) throw new Error(`duplicate property ids: ${[...new Set(dup)].join(', ')}`);
  const declared: readonly string[] = PROPERTY_IDS;
  const missing = declared.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !declared.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`property set mismatch: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
}

const PRECEDENCE: readonly number[] = [EXIT.infra, EXIT.reproDiverged, EXIT.violation, EXIT.ok];

/** infra > reproDiverged > violation > ok; worst([]) = ok. Unknown codes throw. */
export function worst(codes: readonly number[]): number {
  for (const c of codes) {
    if (!PRECEDENCE.includes(c)) throw new Error(`worst: unsupported exit code ${c}`);
  }
  return PRECEDENCE.find((p) => codes.includes(p)) ?? EXIT.ok;
}
