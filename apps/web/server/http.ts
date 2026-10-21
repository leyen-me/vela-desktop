import type { IncomingMessage, ServerResponse } from 'node:http';
import { JSON_TYPE, API_PREFIX, MAX_BODY_CHARS } from './config.ts';
import { AppError, ERROR_CODES } from './errors.ts';

type Envelope = { code: number; message: string; data: unknown; timestamp: number };
type JsonBody = Record<string, any>;

const isEnvelope = (value: unknown): value is Envelope =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  'code' in value &&
  'message' in value &&
  'data' in value &&
  'timestamp' in value;

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer | Record<string, unknown> | unknown[],
  type = JSON_TYPE,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (!type.includes('application/json')) {
    res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(body as string | Buffer);
    return;
  }

  let payload: unknown = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = body;
    }
  }

  if (!isEnvelope(payload)) {
    const failed = status >= ERROR_CODES.BAD_REQUEST;
    const source = (payload ?? {}) as { error?: unknown; message?: unknown; details?: unknown };
    const message = failed ? String(source.error ?? source.message ?? 'request failed') : 'ok';
    payload = {
      code: failed ? status : ERROR_CODES.OK,
      message,
      data: failed ? (source.details ?? null) : payload,
      timestamp: Date.now(),
    };
  }

  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload));
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}

// `/api/v1/health` and the legacy `/api/health` resolve to the same route string.
export function stripApiPrefix(pathname: string): string {
  return pathname.startsWith(API_PREFIX) ? `/api${pathname.slice(API_PREFIX.length) || '/'}` : pathname;
}

export function readJsonBody<T = JsonBody>(req: IncomingMessage, maxChars = MAX_BODY_CHARS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let body = '';
    let settled = false;
    const fail = (error: AppError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      body += chunk;
      if (body.length > maxChars) {
        fail(new AppError('request body too large', { status: ERROR_CODES.PAYLOAD_TOO_LARGE }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve((body ? JSON.parse(body) : {}) as T);
      } catch {
        reject(new AppError('invalid JSON body'));
      }
    });
    req.on('error', (error: Error) => fail(new AppError(error.message, { status: ERROR_CODES.BAD_REQUEST })));
  });
}

export function paginate<T>(items: T[], { page, pageSize }: { page: number; pageSize: number }): {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
} {
  const total = items.length;
  const offset = (page - 1) * pageSize;
  return { items: items.slice(offset, offset + pageSize), page, pageSize, total };
}
