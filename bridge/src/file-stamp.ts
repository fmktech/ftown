/**
 * Stat-based validation for in-memory caches of small files.
 *
 * A cached parse is reused only while a fresh stat matches the stamp it was
 * read under. That is sound only if every later change produces a different
 * stamp, and a timestamp alone does not guarantee it: Linux takes mtime and
 * ctime from a coarse clock (one tick is several milliseconds), so a same-size
 * in-place rewrite landing in the tick of the previous change keeps ino, size,
 * mtime and ctime identical. Like git's "racily clean" rule, a stamp is
 * therefore trusted only once the file has been quiet for longer than any
 * timestamp granularity at the moment the read starts; younger files are
 * re-read on every call.
 */

/** Identity of one on-disk revision of a file, from a single bigint stat. */
export interface FileStamp {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Longer than any filesystem's timestamp granularity (FAT's 2s mtime included) plus clock jitter. */
export const RACY_STAMP_MARGIN_MS = 2_000;

const NS_PER_MS = BigInt(1_000_000);

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * True when content read under `stamp` may be cached: the file's last change
 * (mtime or ctime) is more than the racy margin older than `readStartedAtMs`,
 * a wall-clock time taken before the file was read. Any change made after
 * that read then lands in a later timestamp tick and changes the stamp.
 * A timestamp in the future (clock skew) is never trusted.
 */
export function isSettledStamp(stamp: FileStamp, readStartedAtMs: number): boolean {
  const newest = stamp.mtimeNs > stamp.ctimeNs ? stamp.mtimeNs : stamp.ctimeNs;
  return readStartedAtMs - Number(newest / NS_PER_MS) > RACY_STAMP_MARGIN_MS;
}

/** Only the stamp fields, so a cache entry does not retain a whole Stats object. */
export function toFileStamp(stats: FileStamp): FileStamp {
  return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}
