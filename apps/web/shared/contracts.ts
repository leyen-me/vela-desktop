// Single source of truth for the HTTP contract shared by the server and the client.

export type ApiEnvelope<T = unknown> = {
  code: number;
  message: string;
  data: T;
  timestamp: number;
};

export type PaginationQuery = {
  page: number;
  pageSize: number;
};

export type Paginated<T> = PaginationQuery & {
  items: T[];
  total: number;
};

export type BarDto = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type SymbolDto = {
  ticker: string;
  description?: string;
  type?: string;
  section?: string;
};

export type IndicatorDto = {
  name: string;
  file: string;
  family: string;
};

export type CustomIndicatorDto = {
  id: string;
  name: string;
  script: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ErrorBody = {
  error: string;
  details: unknown;
};
