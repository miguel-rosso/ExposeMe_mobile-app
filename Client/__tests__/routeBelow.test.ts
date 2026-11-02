import { routeNameBelow } from "../app/hooks/useRouteBelow";

// EXP-363: the waiting room tells an invite link pushed over the game screen from Play again (which replaces it) by
// the route right under it in the root stack.

const state = (...names: string[]) => ({ routes: names.map((name, i) => ({ key: `k${i}`, name })) });

describe("routeNameBelow", () => {
  it("is the route right under the given one", () => {
    expect(routeNameBelow(state("index", "screens/GameScreen", "screens/WaitingRoom"), "k2")).toBe("screens/GameScreen");
    expect(routeNameBelow(state("index", "screens/WaitingRoom"), "k1")).toBe("index");
  });

  it("is null for the bottom route, a route not in the stack, or no state", () => {
    expect(routeNameBelow(state("index", "screens/WaitingRoom"), "k0")).toBeNull();
    expect(routeNameBelow(state("index"), "other")).toBeNull();
    expect(routeNameBelow(undefined, "k0")).toBeNull();
  });
});
