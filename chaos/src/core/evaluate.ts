import { EXIT, PROPERTY_IDS, type PropResult, type PropStatus, type Property, type Rec } from '../contract.ts';

type Verdict = Extract<Rec, { k: 'verdict' }>;

const VALID: Readonly<Record<Property['kind'], readonly PropStatus[]>> = {
  always: ['pass', 'violated', 'unexercised'],
  unreachable: ['pass', 'violated'],
  sometimes: ['hit', 'not_hit'],
};

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

type Outcome = { result: PropResult; crashed: boolean };

function crash(msg: string): Outcome {
  return { result: { status: 'violated', evidence: [msg] }, crashed: true };
}

function run(p: Property, log: readonly Rec[]): Outcome {
  try {
    const r = p.check(log) as PropResult | null | undefined;
    if (r === null || typeof r !== 'object') return crash(`property returned ${r === null ? 'null' : typeof r}`);
    if (!VALID[p.kind].includes(r.status)) {
      return crash(`property returned status ${String(r.status)} invalid for kind ${p.kind}`);
    }
    if (!Array.isArray(r.evidence) || r.evidence.some((e) => typeof e !== 'string')) {
      return crash('property returned evidence that is not a string array');
    }
    return { result: { status: r.status, evidence: [...r.evidence] }, crashed: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return crash(`property threw: ${msg}`);
  }
}

/**
 * A property that throws or returns something malformed is 'violated' and fails the run for every
 * kind, 'sometimes' included: a crashed check must never go green. Each property gets the same
 * deep-frozen copy of the log (verdict records removed), so none can affect another.
 */
export function evaluate(
  props: readonly Property[],
  log: readonly Rec[],
): { verdicts: Verdict[]; exitCode: number } {
  const input = deepFreeze(structuredClone(log.filter((r) => r.k !== 'verdict')));
  let bad = false;
  const verdicts: Verdict[] = props.map((p) => {
    const { result: r, crashed } = run(p, input);
    if (
      crashed ||
      (p.kind === 'always' && (r.status === 'violated' || r.status === 'unexercised')) ||
      (p.kind === 'unreachable' && r.status === 'violated')
    ) {
      bad = true;
    }
    return { k: 'verdict', prop: p.id, kind: p.kind, status: r.status, evidence: r.evidence };
  });
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
