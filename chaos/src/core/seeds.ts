const MAX_SEEDS = 100_000;

/** "1-3,2,7" => [1,2,3,7] (sorted, de-duplicated). "", "3-1", "a", "1,,2" throw. */
export function parseSeeds(text: string): number[] {
  if (text === '') throw new Error('seed list is empty');
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (m === null) throw new Error(`invalid seed list item: ${JSON.stringify(part)}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) throw new Error(`seed out of range: ${part}`);
    if (hi < lo) throw new Error(`inverted seed range: ${part}`);
    if (hi - lo + 1 > MAX_SEEDS || out.size + (hi - lo + 1) > MAX_SEEDS) throw new Error('too many seeds');
    for (let s = lo; s <= hi; s++) out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}
