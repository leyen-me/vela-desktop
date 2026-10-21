type LogLevel = 'info' | 'warn' | 'error';

const serialize = (value: unknown): unknown => {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
};

function write(level: LogLevel, args: unknown[]): void {
  const [first, ...rest] = args;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message: typeof first === 'string' ? first : String(first),
  };
  if (rest.length > 0) record.meta = rest.map(serialize);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export const logger = {
  info: (...args: unknown[]): void => write('info', args),
  warn: (...args: unknown[]): void => write('warn', args),
  error: (...args: unknown[]): void => write('error', args),
};
