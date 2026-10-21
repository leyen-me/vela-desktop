import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  oneOf,
  parseInteger,
  parsePagination,
  requireString,
  resolveWithin,
  usSymbol,
} from '../server/validate.ts';
import { paginate } from '../server/http.ts';

test('requireString trims and enforces boundaries', () => {
  assert.equal(requireString('  AAPL.US  ', 'symbol'), 'AAPL.US');
  assert.equal(requireString('abcd', 'name', { maxLength: 4 }), 'abcd');
  assert.throws(() => requireString('', 'name'), /name is required/);
  assert.throws(() => requireString('abcde', 'name', { maxLength: 4 }), /name is too long/);
});

test('oneOf rejects unknown values', () => {
  assert.equal(oneOf('5m', ['1m', '5m'], 'timeframe'), '5m');
  assert.throws(() => oneOf('7m', ['1m', '5m'], 'timeframe'), /must be one of/);
  assert.throws(() => oneOf(undefined, ['1m', '5m'], 'timeframe'), /must be one of/);
});

test('parseInteger handles min, max and fallback', () => {
  assert.equal(parseInteger('3', 'count', { min: 1, max: 5 }), 3);
  assert.equal(parseInteger(5, 'count', { min: 1, max: 5 }), 5);
  assert.equal(parseInteger(1, 'count', { min: 1, max: 5 }), 1);
  assert.equal(parseInteger(null, 'count', { fallback: 500 }), 500);
  assert.equal(parseInteger('', 'count', { fallback: 500 }), 500);
  assert.throws(() => parseInteger('6', 'count', { min: 1, max: 5 }), /between 1 and 5/);
  assert.throws(() => parseInteger('1.5', 'count'), /must be an integer/);
  assert.throws(() => parseInteger(null, 'count'), /count is required/);
});

test('usSymbol normalizes prefixed tickers and rejects non-US symbols', () => {
  assert.equal(usSymbol('AAPL.US'), 'AAPL.US');
  assert.equal(usSymbol('longbridge:SPY.US'), 'SPY.US');
  assert.throws(() => usSymbol('AAPL'), /must be a US ticker/);
  assert.throws(() => usSymbol('aapl.us'), /must be a US ticker/);
});

test('parsePagination applies defaults and rejects oversized pages', () => {
  assert.deepEqual(parsePagination(new URLSearchParams()), { page: 1, pageSize: 100 });
  assert.deepEqual(parsePagination(new URLSearchParams('page=2&pageSize=50')), { page: 2, pageSize: 50 });
  assert.throws(() => parsePagination(new URLSearchParams('pageSize=5001')), /between 1 and 5000/);
  assert.throws(() => parsePagination(new URLSearchParams('page=0')), /between 1/);
});

test('resolveWithin blocks traversal and absolute paths', () => {
  const base = '/srv/data/pine';
  assert.equal(resolveWithin(base, 'trend/ema.pine'), '/srv/data/pine/trend/ema.pine');
  assert.throws(() => resolveWithin(base, '../secret'), /invalid path/);
  assert.throws(() => resolveWithin(base, '/etc/passwd'), /invalid path/);
});

test('paginate slices by page and reports the total', () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(rows, { page: 1, pageSize: 2 }), { items: [1, 2], page: 1, pageSize: 2, total: 5 });
  assert.deepEqual(paginate(rows, { page: 3, pageSize: 2 }), { items: [5], page: 3, pageSize: 2, total: 5 });
  assert.deepEqual(paginate(rows, { page: 9, pageSize: 2 }), { items: [], page: 9, pageSize: 2, total: 5 });
});
