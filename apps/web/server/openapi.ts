const json = (schema: unknown) => ({ 'application/json': { schema } });
const envelope = (data: unknown) => ({
  type: 'object',
  required: ['code', 'message', 'data', 'timestamp'],
  properties: {
    code: { type: 'integer', description: '0 on success, HTTP status on failure' },
    message: { type: 'string' },
    data,
    timestamp: { type: 'integer', format: 'int64' },
  },
});
const errorEnvelope = envelope({ type: 'object', nullable: true });

const symbol = { name: 'symbol', in: 'query', required: false, schema: { type: 'string', example: 'AAPL.US' } };
const timeframe = {
  name: 'timeframe',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'] },
};
const page = { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } };
const pageSize = {
  name: 'pageSize',
  in: 'query',
  schema: { type: 'integer', minimum: 1, maximum: 5000, default: 100 },
};

const paginated = (item: unknown) =>
  envelope({
    type: 'object',
    properties: {
      items: { type: 'array', items: item },
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
      total: { type: 'integer' },
    },
  });

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Vela Web API',
    version: '1.0.0',
    description:
      'Local data and analysis service for the Vela client. All JSON endpoints share a { code, message, data, timestamp } envelope; SSE endpoints stream raw `data:` frames.',
  },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/health': {
      get: {
        summary: 'Service health',
        responses: { 200: { description: 'OK', content: json(envelope({
          type: 'object',
          properties: { status: { type: 'string' }, uptime: { type: 'number' } },
        })) } },
      },
    },
    '/bars': {
      get: {
        summary: 'Candles for a symbol/timeframe',
        parameters: [
          symbol,
          timeframe,
          { name: 'from', in: 'query', schema: { type: 'integer' } },
          { name: 'to', in: 'query', schema: { type: 'integer' } },
          { name: 'count', in: 'query', schema: { type: 'integer', default: 500, maximum: 50000 } },
        ],
        responses: { 200: { description: 'Candles', content: json(envelope({ type: 'object' })) } },
      },
    },
    '/stream': {
      get: {
        summary: 'Realtime candle Server-Sent Events stream',
        parameters: [symbol, timeframe],
        responses: { 200: { description: 'SSE stream' }, 400: { description: 'Bad request' } },
      },
    },
    '/symbols': {
      get: {
        summary: 'US symbol universe',
        parameters: [page, pageSize],
        responses: {
          200: {
            description: 'Paginated symbols',
            content: json(paginated({ type: 'object', properties: { ticker: { type: 'string' } } })),
          },
        },
      },
    },
    '/indicators': {
      get: {
        summary: 'Bundled Pine indicators',
        parameters: [page, pageSize],
        responses: { 200: { description: 'Paginated indicators', content: json(paginated({ type: 'object' })) } },
      },
    },
    '/indicators.json': {
      get: {
        summary: 'Indicator manifest consumed by the chart',
        responses: { 200: { description: 'Manifest', content: json(envelope({ type: 'array', items: { type: 'object' } })) } },
      },
    },
    '/indicators/raw': {
      get: {
        summary: 'Raw Pine source',
        parameters: [{ name: 'file', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'text/plain source' } },
      },
    },
    '/indicators/source': {
      post: {
        summary: 'Overwrite a bundled indicator',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['name', 'script'],
            properties: { name: { type: 'string' }, script: { type: 'string' } },
          }),
        },
        responses: { 200: { description: 'Updated', content: json(envelope({ type: 'object' })) } },
      },
    },
    '/custom-indicators': {
      get: {
        summary: 'List custom indicators',
        parameters: [page, pageSize],
        responses: { 200: { description: 'Paginated custom indicators', content: json(paginated({ type: 'object' })) } },
      },
      post: {
        summary: 'Create or update a custom indicator',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['name', 'script'],
            properties: { id: { type: 'string' }, name: { type: 'string' }, script: { type: 'string' } },
          }),
        },
        responses: { 200: { description: 'Saved', content: json(envelope({ type: 'object' })) } },
      },
      delete: {
        summary: 'Delete a custom indicator',
        parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted', content: json(envelope({ type: 'object' })) } },
      },
    },
    '/agent/status': {
      get: {
        summary: 'dsh agent configuration status',
        responses: { 200: { description: 'Status', content: json(envelope({ type: 'object' })) } },
      },
    },
    '/agent/system': {
      get: {
        summary: 'Chart context sent to the dsh agent',
        parameters: [symbol, timeframe],
        responses: { 200: { description: 'Prompt', content: json(envelope({ type: 'object' })) } },
      },
    },
    '/agent': {
      post: {
        summary: 'Stream a dsh intraday analysis (SSE)',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              timeframe: { type: 'string' },
              messages: { type: 'array', items: { type: 'object' } },
              images: { type: 'array', items: { type: 'object' } },
              context: { type: 'object' },
            },
          }),
        },
        responses: { 200: { description: 'SSE stream' }, 503: { description: 'Missing API key', content: json(errorEnvelope) } },
      },
    },
    '/backtest/session': {
      get: {
        summary: 'Trading-day plan for a backtest',
        parameters: [
          { ...symbol, required: true },
          { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { ...timeframe, required: true },
        ],
        responses: { 200: { description: 'Plan', content: json(envelope({ type: 'object' })) } },
      },
    },
    '/backtest/run': {
      post: {
        summary: 'Run a dsh-driven backtest (SSE)',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['symbol', 'date', 'timeframe'],
            properties: {
              symbol: { type: 'string' },
              date: { type: 'string', format: 'date' },
              timeframe: { type: 'string' },
              initialCapital: { type: 'integer' },
              positionSizePct: { type: 'integer' },
              maxEntriesPerDay: { type: 'integer' },
              slippageBps: { type: 'integer' },
            },
          }),
        },
        responses: { 200: { description: 'SSE stream' } },
      },
    },
    '/backtest/control': {
      post: {
        summary: 'Pause, resume or stop a running backtest',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['runId', 'action'],
            properties: {
              runId: { type: 'string' },
              action: { type: 'string', enum: ['pause', 'resume', 'stop'] },
            },
          }),
        },
        responses: { 200: { description: 'Control state', content: json(envelope({ type: 'object' })) } },
      },
    },
  },
};

export const docsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vela Web API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>`;
