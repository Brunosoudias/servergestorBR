import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

const store = new AsyncLocalStorage<{ requestId: string }>();
const http = new Logger("HTTP");
const VALID_ID = /^[\w.:-]{8,100}$/;

export const currentRequestId = () => store.getStore()?.requestId;

/** Correlaciona logs e respostas pelo X-Request-Id (aceita o do proxy/balanceador ou gera um novo). */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  const requestId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    if (process.env.NODE_ENV === "test" || req.path === "/health" || req.path.startsWith("/health/")) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const line = { requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(durationMs), ip: req.ip };
    if (res.statusCode >= 500) http.error(line); else if (res.statusCode >= 400) http.warn(line); else http.log(line);
  });
  store.run({ requestId }, next);
}
