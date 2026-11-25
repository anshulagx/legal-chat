import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function sendError(res: Response, error: HttpError, retryAfterSeconds?: number) {
  res.status(error.status).json({
    code: error.code,
    message: error.message,
    requestId: res.locals.requestId,
    fields: error.fields,
    retryAfterSeconds,
  });
}

export const requestMetadata: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  const start = performance.now();
  res.locals.requestId = requestId;
  res.set('X-Request-Id', requestId);
  res.once('finish', () => console.info(JSON.stringify({
    requestId,
    method: req.method,
    status: res.statusCode,
    durationMs: Math.round(performance.now() - start),
  })));
  next();
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) return sendError(res, error);
  if (error?.type === 'entity.parse.failed') return sendError(res, new HttpError(400, 'INVALID_JSON', 'Enter a valid JSON body.'));
  if (error?.type === 'entity.too.large') return sendError(res, new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.'));
  console.error(JSON.stringify({ event: 'request_failed', requestId: res.locals.requestId }));
  sendError(res, new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed.'));
};
