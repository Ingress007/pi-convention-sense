/**
 * Git's "racy clean" rule. A file whose mtime and size still match what was recorded is only known to
 * be unchanged if it was already clearly older than the moment it was recorded: a write within the
 * same timestamp tick could keep both. For such files the caller must fall back to reading the content.
 *
 * Returns true when the mtime cannot be trusted. An mtime in the future (clock skew, copied files)
 * can never be trusted either.
 */
export const RACY_WINDOW_MS = 5_000;

export function isRacyClean(mtimeMs: number, referenceMs: number): boolean {
  return referenceMs - mtimeMs <= RACY_WINDOW_MS;
}
