import React, { useDeferredValue } from "react";

/**
 * Renders its children in a background render right after the first commit of where it is mounted, instead of in that
 * commit: a subtree that the first frame doesn't need (e.g. the emoji buttons) stops delaying the paint of the rest.
 */
const DeferredMount = ({ children }: { children: React.ReactNode }) => {
  const ready = useDeferredValue(true, false);
  return ready ? <>{children}</> : null;
};

export default DeferredMount;
