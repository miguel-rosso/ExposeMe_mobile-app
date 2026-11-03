import en from "../src/i18n/en";
import es from "../src/i18n/es";
import { fillTemplate } from "../src/i18n/format";
import { listWaitingNames, MAX_LISTED_WAITING_NAMES, waitingForText } from "../src/utils/waitingFor";

// EXP-380: the pause modal says whom the server waits for (game-paused `waitingFor`), readable for 1, 2 or many

describe("waitingForText", () => {
  it("lists one, two and three names (en/es)", () => {
    expect(waitingForText(["Ana"], en)).toBe("Waiting for Ana…");
    expect(waitingForText(["Ana", "Luis"], en)).toBe("Waiting for Ana and Luis…");
    expect(waitingForText(["Ana", "Luis", "Marta"], en)).toBe("Waiting for Ana, Luis and Marta…");
    expect(waitingForText(["Ana"], es)).toBe("Esperando a Ana…");
    expect(waitingForText(["Ana", "Luis"], es)).toBe("Esperando a Ana y Luis…");
    expect(waitingForText(["Ana", "Luis", "Marta"], es)).toBe("Esperando a Ana, Luis y Marta…");
  });

  it("Spanish writes «e» instead of «y» before an /i/ sound, not before a diphthong", () => {
    expect(waitingForText(["Ana", "Iván"], es)).toBe("Esperando a Ana e Iván…");
    expect(waitingForText(["Ana", "Luis", "ignacio"], es)).toBe("Esperando a Ana, Luis e ignacio…");
    expect(waitingForText(["Ana", "Íñigo"], es)).toBe("Esperando a Ana e Íñigo…");
    expect(waitingForText(["Ana", "Hilda"], es)).toBe("Esperando a Ana e Hilda…");
    expect(waitingForText(["Ana", "Hierro"], es)).toBe("Esperando a Ana y Hierro…");
    expect(waitingForText(["Ana", "Iara"], es)).toBe("Esperando a Ana y Iara…");
    expect(waitingForText(["Iván", "Ana"], es)).toBe("Esperando a Iván y Ana…");
    expect(waitingForText(["Ana", "Iván"], en)).toBe("Waiting for Ana and Iván…");
  });

  it("beyond the listed names sums up the rest", () => {
    const names = ["Ana", "Luis", "Marta", "Pablo", "Sara"];
    expect(MAX_LISTED_WAITING_NAMES).toBe(3);
    expect(waitingForText(names, en)).toBe("Waiting for Ana, Luis and 3 more…");
    expect(waitingForText(names.slice(0, 4), es)).toBe("Esperando a Ana, Luis y 2 más…");
  });

  it("falls back to the generic line when the list is empty", () => {
    expect(waitingForText([], en)).toBe(en.waitingPlayersReturn);
    expect(waitingForText([], es)).toBe(es.waitingPlayersReturn);
  });

  it("inserts names verbatim: no String.replace patterns nor placeholders are expanded", () => {
    expect(waitingForText(["$&", "$1$$"], en)).toBe("Waiting for $& and $1$$…");
    expect(waitingForText(["{names}", "{count}"], es)).toBe("Esperando a {names} y {count}…");
    expect(listWaitingNames(["$'", "$`", "{count}", "x"], en)).toBe("$', $` and 2 more");
  });
});

describe("fillTemplate", () => {
  it("fills every known placeholder in one pass and leaves unknown ones", () => {
    expect(fillTemplate("Pause {pause} of {max}", { pause: "{max}", max: "3" })).toBe("Pause {max} of 3");
    expect(fillTemplate("{a} {b}", { a: "1" })).toBe("1 {b}");
  });
});
