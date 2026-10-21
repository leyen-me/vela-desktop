import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BarDto } from '../shared/contracts.ts';
import { logger } from './logger.ts';
import { DEFAULT_AGENT_BASE_URL, MAX_PROMPT_BARS, MAX_PROMPT_CONTEXT_CHARS } from './config.ts';
import { agentTfLabel, fetchWindow, tzForSymbol } from './longbridge.ts';

type Bar = BarDto;

export type AgentConfig = {
  key: string;
  source: 'env' | 'file' | null;
  base: string;
  model: string;
  effort: 'low' | 'high' | 'max';
};
type AgentFile = { apiKey?: string; baseURL?: string; model?: string; reasoningEffort?: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');

export function loadAgentConfig(): AgentConfig {
  let file: AgentFile = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agent.json'), 'utf8')) as AgentFile;
  } catch {
    /* no local config */
  }
  const envKey = process.env.DEEPSEEK_API_KEY || '';
  const effortRaw = process.env.AGENT_REASONING_EFFORT || file.reasoningEffort || 'low';
  const effort = effortRaw === 'high' || effortRaw === 'max' ? effortRaw : 'low';
  return {
    key: envKey || file.apiKey || '',
    source: envKey ? ('env' as const) : file.apiKey ? ('file' as const) : null,
    base: (process.env.DEEPSEEK_BASE_URL || file.baseURL || DEFAULT_AGENT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || file.model || 'deepseek-flash',
    effort,
  };
}

function startOfTodayMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offset = localAsUtc - Math.floor(ms / 1000) * 1000;
  return Date.UTC(get('year'), get('month') - 1, get('day')) - offset;
}

function todayLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function clockLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

async function todayBars(symbol: string, tf: string): Promise<Bar[]> {
  const tz = tzForSymbol(symbol);
  const to = Date.now();
  const from = startOfTodayMs(to, tz);
  try {
    const { bars } = await fetchWindow(symbol, tf, from, to, 2000);
    return bars.filter((bar: Bar) => bar.time >= from && bar.time <= to);
  } catch (e) {
    logger.warn('[agent] today bars failed:', (e as Error).message);
    return [];
  }
}

export const LIVE_PERSONA = [
  '你是桌面图表应用中的日内交易分析助手。刚刚有一根 K 线收盘，请根据最新结构为交易者做分析。',
  '请用简体中文回答。先说这根收盘 K 线带来了什么变化，再给出倾向、关键价位、触发条件、失效条件和风险。',
  '所有价位必须来自给定数据或明确说明的假设，禁止编造价格、新闻或指标数值。',
  '保持简洁：每次收盘都会运行，不要重复整段历史。',
  '这是分析辅助，不是确定性预测，也不构成投资建议；不涉及下单执行。',
].join('\n');

export async function buildAgentPrompt(body: Record<string, any>, hasImages = false): Promise<string> {
  const symbol = typeof body.symbol === 'string' ? body.symbol : '';
  const ticker = symbol.split(':').pop();
  const timeframe = agentTfLabel(typeof body.timeframe === 'string' ? body.timeframe : '');
  const context = body.context && typeof body.context === 'object' ? body.context : {};
  const tz = ticker ? tzForSymbol(ticker) : 'UTC';
  const now = Date.now();
  const bars = ticker ? await todayBars(ticker, agentTfLabel(body.timeframe)) : [];
  const shown = bars.slice(-MAX_PROMPT_BARS);
  const lines = shown.map((bar) => `${clockLabel(bar.time, tz)} ${bar.open} ${bar.high} ${bar.low} ${bar.close} ${bar.volume ?? 0}`);
  return [
    `标的：${symbol || '未知'} ｜ 周期：${timeframe} ｜ 市场时区：${tz}`,
    `交易日：${todayLabel(now, tz)} ｜ 当前时间：${clockLabel(now, tz)}（${new Date(now).toISOString()}）`,
    `客户端上下文：${JSON.stringify(context).slice(0, MAX_PROMPT_CONTEXT_CHARS)}`,
    `当日 K 线（共 ${shown.length} 根，按时间从旧到新；列依次为：时间 开盘 最高 最低 收盘 成交量）：`,
    ...lines,
    hasImages
      ? '已附当前图表截图。请结合 K 线数据，解读截图中的 SMC 标记（BOS/CHoCH、订单块、FVG、等高/等低）。'
      : '未附截图。请只依据 K 线数据和客户端上下文分析。',
  ].join('\n');
}

