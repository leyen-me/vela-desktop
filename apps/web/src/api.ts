export const API_BASE = '/api/v1';
import type { ApiEnvelope } from '../shared/contracts.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

export type RequestOptions = Omit<RequestInit, 'body'> & { timeout?: number; body?: BodyInit | null };

export class ApiError extends Error {
  status: number;
  code: number;
  data: unknown;

  constructor(message: string, { status = 0, code = status, data = null }: { status?: number; code?: number; data?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function apiRequest<T = any>(path: string, { timeout = DEFAULT_TIMEOUT_MS, signal, ...init }: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetch(apiUrl(path), { ...init, signal: signal ?? controller.signal });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, { status: res.status });
      return res as unknown as T;
    }

    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await res.json()) as ApiEnvelope<T>;
    } catch {
      throw new ApiError('响应格式错误', { status: res.status });
    }

    if (!res.ok || envelope?.code !== 0) {
      throw new ApiError(envelope?.message || `HTTP ${res.status}`, {
        status: res.status,
        code: envelope?.code ?? res.status,
        data: envelope?.data ?? null,
      });
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && !signal?.aborted) {
      throw new ApiError('请求超时');
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const api = {
  get: <T = any>(path: string, options?: RequestOptions) => apiRequest<T>(path, options),
  post: <T = any>(path: string, body: unknown, options: RequestOptions = {}) =>
    apiRequest<T>(path, {
      ...options,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    }),
  del: <T = any>(path: string, options: RequestOptions = {}) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
