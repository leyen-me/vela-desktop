import path from 'node:path';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './config.ts';
import { badRequest } from './errors.ts';

type IntegerOptions = { min?: number; max?: number; fallback?: number };
type PaginationOptions = { defaultPageSize?: number; maxPageSize?: number };

export function requireString(value: unknown, field: string, { maxLength = 200 }: { maxLength?: number } = {}): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} is required`);
  }
  if (value.length > maxLength) throw badRequest(`${field} is too long`);
  return value.trim();
}

export function oneOf(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function parseInteger(
  value: unknown,
  field: string,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback }: IntegerOptions = {},
): number {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field} is required`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export function usSymbol(value: unknown, field = 'symbol'): string {
  const raw = requireString(value, field, { maxLength: 32 });
  const ticker = raw.includes(':') ? (raw.split(':').pop() ?? raw) : raw;
  if (!/^[A-Z0-9.]+\.US$/.test(ticker)) throw badRequest(`${field} must be a US ticker`);
  return ticker;
}

export function parsePagination(
  searchParams: URLSearchParams,
  { defaultPageSize = DEFAULT_PAGE_SIZE, maxPageSize = MAX_PAGE_SIZE }: PaginationOptions = {},
): { page: number; pageSize: number } {
  const page = parseInteger(searchParams.get('page'), 'page', { min: 1, fallback: 1 });
  const pageSize = parseInteger(searchParams.get('pageSize'), 'pageSize', {
    min: 1,
    max: maxPageSize,
    fallback: defaultPageSize,
  });
  return { page, pageSize };
}

export function resolveWithin(base: string, relative: string, field = 'path'): string {
  const full = path.resolve(base, relative);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw badRequest(`invalid ${field}`);
  return full;
}
