export const ERROR_CODES = {
  OK: 0,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
} as const;

export type AppErrorOptions = { status?: number; code?: number; details?: unknown };

export class AppError extends Error {
  status: number;
  code: number;
  details: unknown;

  constructor(message: string, { status = ERROR_CODES.BAD_REQUEST, code = status, details = null }: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(message, { status: ERROR_CODES.BAD_REQUEST, details });

export const notFound = (message = 'not found'): AppError =>
  new AppError(message, { status: ERROR_CODES.NOT_FOUND });

export const methodNotAllowed = (): AppError =>
  new AppError('method not allowed', { status: ERROR_CODES.METHOD_NOT_ALLOWED });
