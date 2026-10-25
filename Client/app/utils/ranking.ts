// Standard competition ranking ("1224"): players with the same points share a
// position and the next position skips the tied ones (10, 10, 5 -> 1, 1, 3).

export type Ranked<T> = T & { rank: number };

/** Sorts by points (desc, stable for ties) and attaches the shared rank. */
export const rankScores = <T extends { points: number }>(scores: T[]): Ranked<T>[] => {
  const sorted = [...scores].sort((a, b) => b.points - a.points);
  let rank = 0;
  return sorted.map((s, i) => {
    if (i === 0 || s.points !== sorted[i - 1].points) rank = i + 1;
    return { ...s, rank };
  });
};

/** Every player tied for first place (empty list when there are no scores). */
export const getWinners = <T extends { points: number }>(scores: T[]): Ranked<T>[] =>
  rankScores(scores).filter((s) => s.rank === 1);
