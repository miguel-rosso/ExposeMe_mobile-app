// ── Hidden delay of a planted round (EXP-126, EXP-146) ──
// A planted round shows a normal photo wait, then its photo after an upload-like delay, so nobody can tell it from a
// player's upload. The delay is drawn from a fixed distribution of realistic photo waits (gallery pick + upload on a
// phone), mixed with the PLANTER's own real waits in this room (waiting-photo → accepted photo-sent) as they come in,
// so the planted photo arrives like that player's uploads do. Nobody else's waits count: other rooms, other players
// of the room and players who left can't shift it.

// Fixed distribution: log-normal around a median wait, clamped to a realistic range
export const TYPICAL_WAIT_MEDIAN = 2_000;
const TYPICAL_WAIT_LOG_SIGMA = 0.5; // ~95 % of the draws between 0.75 and 5.3 s before clamping
export const TYPICAL_WAIT_MIN = 800;
export const TYPICAL_WAIT_MAX = 6_000;
// The planter's own waits replace it gradually: with n of them, one is drawn with probability n / (n + this)
const FIXED_DISTRIBUTION_WEIGHT = 4;
const OWN_WAIT_JITTER = 0.15; // ± share applied to a drawn own wait
const OWN_WAIT_FLOOR = 500;
export const WAITS_PER_PLAYER = 3; // latest real waits kept per player
/** Longest planted delay: an own wait (at most TYPICAL_WAIT_MAX, see record) with the largest jitter */
export const PLANTED_DELAY_MAX = Math.round(TYPICAL_WAIT_MAX * (1 + OWN_WAIT_JITTER));

/** One room's real photo waits, the latest WAITS_PER_PLAYER of each player. */
export class PhotoWaitHistory {
  private waits = new Map<string, number[]>();

  /** `player`'s photo was accepted `ms` after its waiting-photo (counted as at most TYPICAL_WAIT_MAX). */
  record(player: string, ms: number): void {
    const own = [...(this.waits.get(player) ?? []), Math.min(TYPICAL_WAIT_MAX, Math.max(0, ms))];
    this.waits.set(player, own.slice(-WAITS_PER_PLAYER));
  }

  of(player: string): readonly number[] {
    return this.waits.get(player) ?? [];
  }

  /** Forgets the waits of everyone but `players` (players who left the room). */
  keepOnly(players: readonly string[]): void {
    for (const player of [...this.waits.keys()]) if (!players.includes(player)) this.waits.delete(player);
  }
}

/** A draw of the fixed distribution of realistic photo waits (ms). */
export function typicalPhotoWait(random: () => number = Math.random): number {
  // Box-Muller: a standard normal value from two uniform ones (1 - u avoids log(0))
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const ms = TYPICAL_WAIT_MEDIAN * Math.exp(TYPICAL_WAIT_LOG_SIGMA * normal);
  return Math.round(Math.min(TYPICAL_WAIT_MAX, Math.max(TYPICAL_WAIT_MIN, ms)));
}

/** A planted round's hidden delay (ms, at most `maxDelay`) for a planter with these past waits. */
export function drawPlantedDelay(plantersWaits: readonly number[], maxDelay: number, random: () => number = Math.random): number {
  const ownShare = plantersWaits.length / (plantersWaits.length + FIXED_DISTRIBUTION_WEIGHT);
  if (random() >= ownShare) return Math.min(maxDelay, typicalPhotoWait(random));
  const own = plantersWaits[Math.floor(random() * plantersWaits.length)];
  const jittered = own * (1 + (random() * 2 - 1) * OWN_WAIT_JITTER);
  return Math.round(Math.min(maxDelay, Math.max(OWN_WAIT_FLOOR, jittered)));
}
