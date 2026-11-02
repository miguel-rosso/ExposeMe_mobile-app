// ── Home route ──
// Home is always at the bottom of the stack (app/_layout.tsx anchors it, even under a cold-start invite link). Every
// way back to it is router.dismissTo(HOME_PATH) (hooks/useGoHome): it pops to that home, whereas replace("/") stacks a
// second one over it, whose Android back then reopens the old one (EXP-339).

export const HOME_PATH = "/";
