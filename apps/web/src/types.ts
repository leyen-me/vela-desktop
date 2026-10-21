import type { BarDto } from '../shared/contracts.ts';

export type Bar = BarDto;
export type BarRange = { limit?: number; from?: number | null; to?: number | null };
export type SymbolRow = { ticker: string; description?: string; type?: string; section?: string };
export type JsonObject = Record<string, any>;
export type VelaChart = any;
export type VelaCell = any;
