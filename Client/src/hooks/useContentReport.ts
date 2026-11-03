import { useCallback, useEffect, useRef, useState } from "react";
import type { AckSocket } from "../utils/socketAck";
import { reportOutcome, ReportReason, ReportTarget, sendContentReport } from "../utils/contentReport";

/**
 * Where a report is (EXP-423): picking its reason, waiting for the server's ack, sent (the thanks, with the offer to
 * mute that player), refused for good (nothing to report there any more: close), or failed (no answer: try again or
 * close).
 */
export type ReportFlow =
  | { step: "closed" }
  | { step: "reasons"; target: ReportTarget }
  | { step: "sending"; target: ReportTarget; reason: ReportReason }
  | { step: "sent"; target: ReportTarget }
  | { step: "refused"; target: ReportTarget }
  | { step: "failed"; target: ReportTarget; reason: ReportReason };

const CLOSED: ReportFlow = { step: "closed" };

/**
 * The report dialog's state: `start` opens the reason picker for a photo or a chat bubble, `choose` sends the report
 * with that reason, `retry` sends it again after it failed, `close` ends it at any step. An ack that comes once the
 * dialog was closed (or another report started) changes nothing.
 */
export const useContentReport = (socket: AckSocket | null) => {
  const [flow, setFlow] = useState<ReportFlow>(CLOSED);
  // The report being sent: an ack for any other one (closed, replaced) is ignored
  const sendingRef = useRef<ReportTarget | null>(null);
  useEffect(() => () => { sendingRef.current = null; }, []);

  const start = useCallback((target: ReportTarget) => {
    sendingRef.current = null;
    setFlow({ step: "reasons", target });
  }, []);

  const close = useCallback(() => {
    sendingRef.current = null;
    setFlow(CLOSED);
  }, []);

  const send = useCallback(async (target: ReportTarget, reason: ReportReason) => {
    sendingRef.current = target;
    setFlow({ step: "sending", target, reason });
    const ack = socket ? await sendContentReport(socket, target, reason) : null;
    if (sendingRef.current !== target) return;
    sendingRef.current = null;
    const outcome = reportOutcome(ack);
    setFlow(outcome === "failed" ? { step: "failed", target, reason } : { step: outcome, target });
  }, [socket]);

  const choose = (reason: ReportReason) => {
    if (flow.step === "reasons") void send(flow.target, reason);
  };

  const retry = () => {
    if (flow.step === "failed") void send(flow.target, flow.reason);
  };

  return { flow, start, choose, retry, close };
};

export type ContentReport = ReturnType<typeof useContentReport>;
