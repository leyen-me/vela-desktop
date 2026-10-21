import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api-server.ts');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let child: ChildProcess | undefined;

before(async () => {
  child = spawn(process.execPath, ['--experimental-strip-types', SERVER], {
    env: { ...process.env, API_PORT: String(PORT) },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* server not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('api server did not become healthy');
});

after(() => {
  child?.kill();
});

const envelope = (body: any) => {
  assert.equal(typeof body.code, 'number');
  assert.equal(typeof body.message, 'string');
  assert.equal(typeof body.timestamp, 'number');
  assert.ok('data' in body);
};

test('GET /api/v1/health reports ok inside the standard envelope', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  envelope(body);
  assert.equal(body.code, 0);
  assert.equal(body.data.status, 'ok');
  assert.equal(typeof body.data.uptime, 'number');
});

test('legacy /api/health is still served', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  assert.equal(res.status, 200);
});

test('GET /api/v1/openapi.json exposes the API contract', async () => {
  const res = await fetch(`${BASE}/openapi.json`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  envelope(body);
  assert.equal(body.data.openapi, '3.1.0');
  assert.ok(body.data.paths['/health']);
});

test('unknown routes return the standard error envelope', async () => {
  const res = await fetch(`${BASE}/does-not-exist`);
  assert.equal(res.status, 404);
  const body: any = await res.json();
  envelope(body);
  assert.equal(body.code, 404);
  assert.equal(body.data, null);
});

test('query validation rejects bad input with 400', async () => {
  const res = await fetch(`${BASE}/bars?tf=nope`);
  assert.equal(res.status, 400);
  const body: any = await res.json();
  envelope(body);
  assert.equal(body.code, 400);
});

test('list endpoints are paginated', async () => {
  const res = await fetch(`${BASE}/indicators?page=1&pageSize=2`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  envelope(body);
  assert.ok(Array.isArray(body.data.items));
  assert.ok(body.data.items.length <= 2);
  assert.equal(body.data.page, 1);
  assert.equal(body.data.pageSize, 2);
  assert.ok(body.data.total >= body.data.items.length);
});
