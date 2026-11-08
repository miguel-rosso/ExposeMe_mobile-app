import { NextFunction, Request, Response } from "express";

/**
 * Final Express error handler: answers `{ error }` JSON and never sends the stack, messages or file paths
 * (Express' default handler does outside NODE_ENV=production). Client errors raised by Express
 * (status 4xx, e.g. malformed percent-encoding in the URL) keep their status with a generic message; anything
 * else is a 500 and is logged server-side.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  const raw = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
  const status = typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : 500;

  if (status === 500) console.error(`[http] ${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return next(err); // let Express close the connection

  res.status(status).json({ error: status === 413 ? "Payload too large" : status === 500 ? "Internal server error" : "Bad request" });
}
