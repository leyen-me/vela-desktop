import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..', '..');

export const DSH_ROOT = process.env.DSH_DATA_DIR || path.join(ROOT, 'data', 'dsh');
export const DSH_HOME = path.join(DSH_ROOT, 'home');
export const DSH_WORKSPACE = path.join(DSH_ROOT, 'workspace');
export const DSH_PATCH_DIR = path.join(DSH_ROOT, 'patches');

export const DSH_PROVIDER = process.env.DSH_PROVIDER || 'deepseek-official';
export const DSH_MODEL = process.env.DSH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
export const DSH_REASONING_EFFORT = process.env.DSH_REASONING_EFFORT || 'low';
export const DSH_INIT_TIMEOUT_MS = Number(process.env.DSH_INIT_TIMEOUT_MS) || 60_000;
export const DSH_TURN_TIMEOUT_MS = Number(process.env.DSH_TURN_TIMEOUT_MS) || 180_000;
export const DSH_BACKTEST_TIMEOUT_MS = Number(process.env.DSH_BACKTEST_TIMEOUT_MS) || 240_000;

export const DSH_ENABLED = process.env.DSH_ENABLED !== 'false';

export function ensureDshDirs(): void {
  for (const dir of [DSH_ROOT, DSH_HOME, DSH_WORKSPACE, DSH_PATCH_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function assertDshNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 24 || major === 24 || (major === 22 && minor >= 19)) return;
  throw new Error(
    `DeepSeek Harness 需要 Node ^22.19 或 >=24，当前为 ${process.versions.node}。请升级 Node 后重启 API 服务。`,
  );
}

export function hasDeepSeekKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}
