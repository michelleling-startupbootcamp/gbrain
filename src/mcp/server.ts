import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { Operation, OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';

/** Validate required params exist and have the expected type */
function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

/** Create and configure a new MCP Server instance */
function createServer(engine: BrainEngine): Server {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(operations),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = operations.find(o => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    const ctx: OperationContext = {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
      dryRun: !!(params?.dry_run),
      // MCP callers are remote/untrusted; enforce strict file confinement.
      remote: true,
    };

    const safeParams = params || {};
    const validationError = validateParams(op, safeParams);
    if (validationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }], isError: true };
    }

    try {
      const result = await op.handler(ctx, safeParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

export async function startMcpServer(engine: BrainEngine) {
  const port = parseInt(process.env.PORT || '0', 10);

  if (port > 0) {
    // HTTP transport mode — used when deployed on Railway (PORT is injected automatically)
    console.error(`Starting GBrain MCP server (HTTP) on port ${port}...`);

    Bun.serve({
      port,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);

        // Health check endpoint
        if (url.pathname === '/' || url.pathname === '/health') {
          return new Response(
            JSON.stringify({ status: 'ok', service: 'gbrain', version: VERSION }),
            { headers: { 'content-type': 'application/json' } },
          );
        }

        // MCP endpoint — stateless: each request gets its own Server + transport
        if (url.pathname === '/mcp') {
          const server = createServer(engine);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless mode
          });
          await server.connect(transport);
          return await transport.handleRequest(req);
        }

        return new Response('Not found', { status: 404 });
      },
    });

    // Keep process alive indefinitely
    await new Promise<never>(() => {});
  } else {
    // Stdio transport mode — used by local MCP clients (Hermes, Claude Desktop)
    console.error('Starting GBrain MCP server (stdio)...');
    const server = createServer(engine);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

// Backward compat: used by `gbrain call` command
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx: OperationContext = {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: !!(params?.dry_run),
    // Backing path for `gbrain call` CLI command — trusted local invocation.
    remote: false,
  };

  return op.handler(ctx, params);
}
