export const API_PREFIX = '/api/v1';
export const DEFAULT_PORT = 5174;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 5000;
export const MAX_BODY_CHARS = 1_000_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const JSON_TYPE = 'application/json; charset=utf-8';
export const TEXT_TYPE = 'text/plain; charset=utf-8';

export const DEFAULT_BAR_COUNT = 500;
export const BAR_PAGE_SIZE = 1000;
export const MAX_BAR_LIMIT = 50_000;
export const INTRADAY_TTL_MS = 60_000;
export const DAILY_TTL_MS = 30 * 60_000;
export const US_SYMBOLS_TTL_MS = 24 * 60 * 60_000;
export const AGENT_BODY_LIMIT = 8_000_000;
export const BACKTEST_BODY_LIMIT = 200_000;
export const CONTROL_BODY_LIMIT = 20_000;
export const MAX_AGENT_MESSAGES = 20;
export const MAX_AGENT_IMAGES = 2;
export const MAX_PROMPT_CONTEXT_CHARS = 1500;
export const MAX_PROMPT_BARS = 500;

export const DEFAULT_AGENT_BASE_URL = 'https://api.deepseek.com';

export const DEFAULT_HOST = '127.0.0.1';
