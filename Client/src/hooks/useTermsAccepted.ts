import { useCallback, useEffect, useRef, useState } from "react";
import { hasAcceptedCurrentTerms } from "../utils/termsAcceptance";

/**
 * Whether this device accepted the current terms of use (utils/termsAcceptance): undefined until the stored version
 * is read on mount. `refresh` reads it again (e.g. when they may have been accepted on another screen). A failed read
 * counts as not accepted, so the terms are asked for again.
 */
export const useTermsAccepted = (): [accepted: boolean | undefined, refresh: () => void] => {
  const [accepted, setAccepted] = useState<boolean>();
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    hasAcceptedCurrentTerms()
      .catch(() => false)
      .then((value) => {
        if (mountedRef.current) setAccepted(value);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return [accepted, refresh];
};
