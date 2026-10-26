/**
 * Random gallery photo without reading the whole gallery (EXP-174).
 *
 * expo-media-library 58 has no count API, but its Query supports offset + limit and both platforms
 * serve a one-row page cheaply (MediaStore SQL LIMIT/OFFSET on Android, a lazy PHFetchResult slice on iOS).
 * The image count is found once with O(log n) one-row probes and cached; every pick afterwards is a single
 * one-row query at a random offset. The cache is dropped when the gallery changes (or turns out smaller).
 */

/** Id of the image at `offset` in the visible gallery (full or limited selection), null past the end. */
export type PhotoAt = (offset: number) => Promise<string | null>;

/** Number of visible images: exponential probe, then binary search. ~2·log2(n) one-row queries. */
export async function countPhotos(photoAt: PhotoAt): Promise<number> {
  if ((await photoAt(0)) === null) return 0;
  // Invariant: at least `lo` images exist, fewer than `hi` do
  let lo = 1;
  let hi = 2;
  while ((await photoAt(hi - 1)) !== null) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await photoAt(mid - 1)) !== null) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Most one-row draws per pick spent looking for a photo not shown yet this game; past it a repeat is accepted. */
export const MAX_DRAWS_PER_PICK = 8;

/** The `k`-th offset (0-based) not in `taken` (sorted ascending, all < n). */
function nthFreeOffset(k: number, taken: number[]): number {
  let offset = k;
  for (const t of taken) {
    if (t > offset) break;
    offset++;
  }
  return offset;
}

function insertSorted(list: number[], value: number) {
  let i = 0;
  while (i < list.length && list[i] < value) i++;
  if (list[i] !== value) list.splice(i, 0, value);
}

export interface RandomPhotoPicker {
  /** Id of a uniformly random visible image not picked since the last reset() (while any remain), or null when there is none. */
  pick: () => Promise<string | null>;
  /** Forget the cached count (gallery or limited selection changed). */
  invalidate: () => void;
  /** New game: photos picked so far may come up again. */
  reset: () => void;
}

export function createRandomPhotoPicker(photoAt: PhotoAt, random: () => number = Math.random): RandomPhotoPicker {
  let count: number | null = null; // an empty gallery is never cached: re-checking it costs one query
  let generation = 0; // bumped on every invalidate(): a count started before a change is never cached
  // ── No repeats within a game (EXP-162) ──
  // Ids are the truth; offsets are a fast path valid only for the current count (photos added or removed shift
  // them), so they are dropped on every recount and rebuilt as draws land on photos already shown.
  let usedIds = new Set<string>();
  let usedOffsets: number[] = []; // sorted; offsets known to hold a photo in usedIds

  const pick = async (): Promise<string | null> => {
    // Second pass only if the cached count was stale (photos deleted without a change event)
    for (let attempt = 0; attempt < 2; attempt++) {
      let n = count;
      if (n === null) {
        const startedAt = generation;
        n = await countPhotos(photoAt);
        usedOffsets = [];
        if (n === 0) return null;
        if (generation === startedAt) count = n; // otherwise use it for this pick only
      }
      let repeat: string | null = null;
      let stale = false;
      for (let draw = 0; draw < MAX_DRAWS_PER_PICK; draw++) {
        if (usedOffsets.length >= n) {
          // Every photo has been shown this game: start over, repeats allowed
          usedIds = new Set();
          usedOffsets = [];
        }
        // Uniform over the offsets not known to be used: one query per draw
        const offset = nthFreeOffset(Math.floor(random() * (n - usedOffsets.length)), usedOffsets);
        const id = await photoAt(offset);
        if (id === null) { stale = true; break; }
        insertSorted(usedOffsets, offset);
        if (!usedIds.has(id)) {
          usedIds.add(id);
          return id;
        }
        repeat = id;
      }
      if (!stale) return repeat; // draw budget spent: accept a photo already shown
      count = null;
    }
    return null;
  };

  return {
    pick,
    invalidate: () => {
      generation++;
      count = null;
    },
    reset: () => {
      usedIds = new Set();
      usedOffsets = [];
    },
  };
}
