import type { Translations } from "@/src/i18n/context";
import { fillTemplate } from "@/src/i18n/format";

/** Most names the pause modal lists; with more awaited players the last slot sums up the rest ("2 more") */
export const MAX_LISTED_WAITING_NAMES = 3;

// A word starting with an /i/ sound (I-, Í-, Hi-, but not a diphthong like "Hie-", "Ia-"): Spanish writes "e" instead
// of "y" before it ("Ana e Iván"). English uses the same "and" for both keys.
const STARTS_WITH_I_SOUND = /^h?[iíIÍ](?![aeiouáéíóú])/i;

/** "Ana", "Ana and Luis", "Ana, Luis and Marta" */
const joinWithAnd = (items: readonly string[], t: Translations): string => {
  if (items.length <= 1) return items.join("");
  const last = items[items.length - 1];
  const and = STARTS_WITH_I_SOUND.test(last) ? t.namesListAndBeforeI : t.namesListAnd;
  return `${items.slice(0, -1).join(", ")} ${and} ${last}`;
};

/** Up to MAX_LISTED_WAITING_NAMES names; beyond that the first ones and "N more" ("Ana, Luis and 2 more") */
export const listWaitingNames = (names: readonly string[], t: Translations): string => {
  if (names.length <= MAX_LISTED_WAITING_NAMES) return joinWithAnd(names, t);
  const listed = names.slice(0, MAX_LISTED_WAITING_NAMES - 1);
  const more = fillTemplate(t.namesListMore, { count: String(names.length - listed.length) });
  return joinWithAnd([...listed, more], t);
};

/** The pause modal's line about who it waits for (game-paused `waitingFor`); generic when the list is empty. */
export const waitingForText = (names: readonly string[], t: Translations): string =>
  names.length === 0 ? t.waitingPlayersReturn : fillTemplate(t.waitingForNames, { names: listWaitingNames(names, t) });
