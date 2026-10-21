import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomIndicatorDto, IndicatorDto } from '../shared/contracts.ts';
import { logger } from './logger.ts';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SERVER_DIR, '..', '..', '..');

export const PINE_DIR = path.join(ROOT, 'data', 'pine');
const CUSTOM_FILE = path.join(ROOT, 'data', 'custom-indicators.json');

// Indicator folders → picker group labels, in display order. The picker groups the
// catalogue by `category`, so this is both the label and the ordering.
export const FAMILY_LABELS: Record<string, string> = {
  trend: '趋势',
  momentum: '动量',
  volatility: '波动率',
  'volume-orderflow': '成交量与订单流',
  levels: '关键价位',
  'market-structure': '市场结构',
  patterns: '形态',
  'elliott-harmonics': '艾略特与谐波',
  wyckoff: '威科夫',
  'smc-ict': 'SMC / ICT',
  statistics: '统计',
  'machine-learning': '机器学习',
  'meta-composition': '组合与元信号',
  'risk-exits': '风控与离场',
  'sentiment-breadth': '情绪与广度',
  'time-seasonality': '时间与季节性',
  unknown: '其他',
};

const FAMILY_ORDER = Object.keys(FAMILY_LABELS);
const familyRank = (family: string): number => {
  const index = FAMILY_ORDER.indexOf(family);
  return index < 0 ? FAMILY_ORDER.length : index;
};

let indexCache: IndicatorDto[] | null = null;

export function listIndicators(): IndicatorDto[] {
  if (indexCache) return indexCache;
  const out: IndicatorDto[] = [];
  for (const family of fs.readdirSync(PINE_DIR)) {
    const dir = path.join(PINE_DIR, family);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.pine')) continue;
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const match = source.match(/indicator\(\s*(['"])(.*?)\1/);
      out.push({ name: match ? match[2] : file.replace(/\.pine$/, ''), file: `${family}/${file}`, family });
    }
  }
  out.sort((a, b) => familyRank(a.family) - familyRank(b.family) || a.name.localeCompare(b.name));
  indexCache = out;
  return out;
}

export function invalidateIndicatorIndex(): void {
  indexCache = null;
}

export function loadCustom(): CustomIndicatorDto[] {
  try {
    const rows = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    return Array.isArray(rows) ? (rows as CustomIndicatorDto[]) : [];
  } catch (error) {
    logger.warn('custom indicators unreadable:', (error as Error).message);
    return [];
  }
}

export function saveCustom(rows: CustomIndicatorDto[]): void {
  fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(rows, null, 2));
}

export function slugId(name: string): string {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'script';
  return `${base}-${Date.now().toString(36)}`;
}
