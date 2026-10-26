import { isRoomCode, parseRoomCodeParam, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, sanitizeRoomCodeInput } from "../app/utils/roomCode";

// EXP-198: 6-character codes from the server's unambiguous alphanumeric alphabet (DEC-022).

describe("room code alphabet", () => {
  it("matches the server's: 31 uppercase alphanumerics without 0/O, 1/I/L", () => {
    expect(ROOM_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    expect(ROOM_CODE_LENGTH).toBe(6);
  });
});

describe("sanitizeRoomCodeInput", () => {
  it.each([
    ["k7mq4x", "K7MQ4X"],
    ["K7m", "K7M"],
    [" k7-mq 4x ", "K7MQ4X"],
    ["K7MQ4XZZ", "K7MQ4X"],
    ["O0I1L", ""],
    ["", ""],
    [" K7MQ4X", "K7MQ4X"],
    ["K7MQ-4X", "K7MQ4X"],
    // ASCII-only uppercase: toUpperCase would add code letters ("ß" → "SS", "ſ" → "S", "ﬀ" → "FF")
    ["K7ßMQ", "K7MQ"],
    ["K7ſMQ", "K7MQ"],
    ["K7ﬀMQ", "K7MQ"],
    ["Ｋ７ＭＱ４Ｘ", ""],
  ])("%j → %j", (typed, kept) => {
    expect(sanitizeRoomCodeInput(typed)).toBe(kept);
  });
});

describe("isRoomCode", () => {
  it("accepts a complete code only", () => {
    expect(isRoomCode("K7MQ4X")).toBe(true);
    for (const v of ["K7MQ4", "k7mq4x", "123456", "K7MQOX", "", null, undefined, 123456]) expect(isRoomCode(v)).toBe(false);
  });
});

describe("parseRoomCodeParam", () => {
  it("normalizes the deep link's code", () => {
    expect(parseRoomCodeParam("K7MQ4X")).toBe("K7MQ4X");
    expect(parseRoomCodeParam(" k7mq4x ")).toBe("K7MQ4X");
    expect(parseRoomCodeParam(["k7mq4x", "ZZZZZZ"])).toBe("K7MQ4X");
  });

  it.each([undefined, "", "123456", "K7MQ4", "K7MQ4X9", "K7<b>X", [], "K7MQß", "K7MQ4ſ", "K7MQﬀ", "Ｋ７ＭＱ４Ｘ", " K7MQ4X"])("rejects %j", (param) => {
    expect(parseRoomCodeParam(param as string | string[] | undefined)).toBeNull();
  });
});
