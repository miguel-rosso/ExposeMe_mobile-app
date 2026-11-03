// ── Home route ──
// Home is always at the bottom of the stack (app/_layout.tsx anchors it, even under a cold-start invite link). Every
// way back to it from a room's screens is hooks/useGoHome: router.dismissTo(HOME_PATH) pops to that home, whereas
// replace("/") stacks a second one over it, whose Android back then reopens the old one (EXP-339), and it marks the
// room exit, the only way home closes the room's socket (a link to "/" pushes another home, which gives way: EXP-373).

export const HOME_PATH = "/";

/** Home's route name in the root stack's navigation state (what useRouteBelow reads) */
export const HOME_ROUTE_NAME = "index";
