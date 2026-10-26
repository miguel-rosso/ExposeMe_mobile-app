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

export interface RandomPhotoPicker {
  /** Id of a uniformly random visible image, or null when there is none. */
  pick: () => Promise<string | null>;
  /** Forget the cached count (gallery or limited selection changed). */
  invalidate: () => void;
}

export function createRandomPhotoPicker(photoAt: PhotoAt, random: () => number = Math.random): RandomPhotoPicker {
  let count: number | null = null; // an empty gallery is never cached: re-checking it costs one query
  let generation = 0; // bumped on every invalidate(): a count started before a change is never cached

  const pick = async (): Promise<string | null> => {
    // Second pass only if the cached count was stale (photos deleted without a change event)
    for (let attempt = 0; attempt < 2; attempt++) {
      let n = count;
      if (n === null) {
        const startedAt = generation;
        n = await countPhotos(photoAt);
        if (n === 0) return null;
        if (generation === startedAt) count = n; // otherwise use it for this pick only
      }
      const offset = Math.floor(random() * n);
      const id = await photoAt(offset);
      if (id !== null) return id;
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
  };
}
