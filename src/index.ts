import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MongoDbClient, MongoError } from './client.js'

export const name = 'dsh-tool-mongodb'
export const inject = ['tools']

export interface MongoDBPluginConfig {
  /** Explicit MongoDB URL; overrides urlEnv when set. */
  url?: string
  /** Environment variable containing the MongoDB URL (default MONGO_URL). */
  urlEnv?: string
  /** Server selection timeout in milliseconds (default 5000). */
  serverSelectionTimeoutMs?: number
}

export function apply(ctx: Context, config: MongoDBPluginConfig = {}) {
  const urlEnv = config.urlEnv ?? 'MONGO_URL'
  const client = new MongoDbClient({
    url: config.url ?? process.env[urlEnv],
    serverSelectionTimeoutMs: config.serverSelectionTimeoutMs,
  })
  for (const tool of createTools(client)) ctx.tools.register(tool)
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function unavailable(reason: string) {
  return { found: false, items: [], reason }
}

function errorReason(error: unknown): string {
  return error instanceof MongoError ? error.message : error instanceof Error ? error.message : String(error)
}

const LIST_RENDER_LIMIT = 20
const DOC_RENDER_LIMIT = 10

function renderPing(value: { ok?: boolean; reason?: string; url?: string; latencyMs?: number }) {
  return value.ok
    ? text(`MongoDB reachable at ${value.url ?? ''} latency=${value.latencyMs ?? 0}ms`)
    : text(`MongoDB connection failed: ${value.reason ?? ''}`)
}

function renderServerInfo(value: { ok?: boolean; reason?: string; mongoVersion?: string; dbName?: string; collections?: number; objects?: number; dataSizeBytes?: number }) {
  if (!value.ok) return text(value.reason ?? 'MongoDB server info unavailable.')
  const sizeMb = ((value.dataSizeBytes ?? 0) / (1024 * 1024)).toFixed(1)
  return text(`MongoDB ${value.mongoVersion ?? ''} db=${value.dbName ?? ''} collections=${value.collections ?? 0} objects=${value.objects ?? 0} dataSize=${sizeMb}MB`)
}

function renderCollections(items: Array<{ name?: string; type?: string }>) {
  if (!items.length) return text('No collections found.')
  const lines = items.slice(0, LIST_RENDER_LIMIT).map(item => `  ${item.name ?? ''} (${item.type ?? ''})`)
  if (items.length > LIST_RENDER_LIMIT) lines.push(`  ... ${items.length - LIST_RENDER_LIMIT} more collections omitted`)
  return text(lines.join('\n'))
}

function renderDocs(value: { found?: boolean; reason?: string; items?: string[]; count?: number; truncated?: boolean }) {
  if (!value.found) return text(value.reason ?? 'MongoDB query unavailable.')
  const items = value.items ?? []
  if (!items.length) return text('No documents matched the filter.')
  const lines = items.slice(0, DOC_RENDER_LIMIT).map((item, index) => `${index + 1}. ${item}`)
  if (items.length > DOC_RENDER_LIMIT) lines.push(`... ${items.length - DOC_RENDER_LIMIT} more documents omitted`)
  if (value.truncated) lines.push('[result set truncated by size budget]')
  return text(lines.join('\n'))
}

function renderWrite(value: { ok?: boolean; reason?: string; applied?: boolean; database?: string; collection?: string; detail?: string }) {
  if (!value.ok) return text(`MongoDB write failed: ${value.reason ?? ''}`)
  return value.applied
    ? text(`Applied on ${value.database ?? ''}.${value.collection ?? ''}: ${value.detail ?? ''}`)
    : text(`No document matched on ${value.database ?? ''}.${value.collection ?? ''}: ${value.detail ?? ''}`)
}

export function createTools(client: MongoDbClient) {
  return [
    defineTool({
      name: 'mongo_ping',
      description: 'Verify MongoDB connectivity and latency. The connection URL is redacted before display.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, url: { type: 'string' }, latencyMs: { type: 'number' } } },
        render: (_args, value) => renderPing(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Ping MongoDB', kind: 'read' } },
      async execute() {
        try { return await client.ping() }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'mongo_server_info',
      description: "Read one database's server version and storage stats.",
      parameters: { database: { type: 'string', required: true, description: 'Database name' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, mongoVersion: { type: 'string' }, dbName: { type: 'string' }, collections: { type: 'number' }, objects: { type: 'number' }, dataSizeBytes: { type: 'number' } } },
        render: (_args, value) => renderServerInfo(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `MongoDB info: ${args.database ?? ''}`, kind: 'read' } },
      async execute(args) {
        if (!args.database) return { ok: false, reason: 'database is required.' }
        try { return { ok: true, ...await client.serverInfo(args.database as string) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'mongo_list_collections',
      description: "List one database's collections (capped at 50 entries).",
      parameters: { database: { type: 'string', required: true, description: 'Database name' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, type: { type: 'string' } } } } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'MongoDB collections unavailable.') : renderCollections(value.items ?? []),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `MongoDB collections: ${args.database ?? ''}`, kind: 'search' } },
      async execute(args) {
        if (!args.database) return unavailable('database is required.')
        try { return { found: true, items: await client.listCollections(args.database as string) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'mongo_count_documents',
      description: 'Count documents matching a JSON filter. Server-side-JavaScript operators are rejected.',
      parameters: {
        database: { type: 'string', required: true, description: 'Database name' },
        collection: { type: 'string', required: true, description: 'Collection name' },
        filterJson: { type: 'string', description: 'JSON filter object, e.g. {"status":"active"} (default {})' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, count: { type: 'number' } } },
        render: (_args, value) => value.ok ? text(`count=${value.count ?? 0}`) : text(`MongoDB count failed: ${value.reason ?? ''}`),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Count ${args.database ?? ''}.${args.collection ?? ''}`, kind: 'read' } },
      async execute(args) {
        if (!args.database || !args.collection) return { ok: false, reason: 'database and collection are required.' }
        try { return { ok: true, ...await client.countDocuments(args.database as string, args.collection as string, args.filterJson ?? '{}') } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'mongo_find_documents',
      description: 'Find documents matching a JSON filter (max 20, serialized previews capped).',
      parameters: {
        database: { type: 'string', required: true, description: 'Database name' },
        collection: { type: 'string', required: true, description: 'Collection name' },
        filterJson: { type: 'string', description: 'JSON filter object (default {})' },
        limit: { type: 'integer', description: 'Maximum documents, 1-20 (default 10)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, count: { type: 'number' }, truncated: { type: 'boolean' } } },
        render: (_args, value) => renderDocs(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Find ${args.database ?? ''}.${args.collection ?? ''}`, kind: 'search' } },
      async execute(args) {
        if (!args.database || !args.collection) return unavailable('database and collection are required.')
        try {
          return { found: true, ...await client.findDocuments(args.database as string, args.collection as string, args.filterJson ?? '{}', args.limit as number) }
        } catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'mongo_insert_one',
      description: 'Insert one document from a JSON object. WRITE operation; the document is never echoed back.',
      parameters: {
        database: { type: 'string', required: true, description: 'Database name' },
        collection: { type: 'string', required: true, description: 'Collection name' },
        docJson: { type: 'string', required: true, description: 'JSON document to insert (max 16000 characters)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, database: { type: 'string' }, collection: { type: 'string' }, detail: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Insert into ${args.database ?? ''}.${args.collection ?? ''}`, kind: 'edit' } },
      async execute(args) {
        if (!args.database || !args.collection || !args.docJson) return { ok: false, reason: 'database, collection, and docJson are required.' }
        try { return await client.insertOne(args.database as string, args.collection as string, args.docJson) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'mongo_update_one',
      description: 'Update the first document matching a JSON filter via $set only. WRITE operation.',
      parameters: {
        database: { type: 'string', required: true, description: 'Database name' },
        collection: { type: 'string', required: true, description: 'Collection name' },
        filterJson: { type: 'string', required: true, description: 'JSON filter selecting the document' },
        setJson: { type: 'string', required: true, description: 'JSON object of fields to $set (plain field names only)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, database: { type: 'string' }, collection: { type: 'string' }, detail: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Update ${args.database ?? ''}.${args.collection ?? ''}`, kind: 'edit' } },
      async execute(args) {
        if (!args.database || !args.collection || !args.filterJson || !args.setJson) return { ok: false, reason: 'database, collection, filterJson, and setJson are required.' }
        try { return await client.updateOne(args.database as string, args.collection as string, args.filterJson, args.setJson) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'mongo_delete_one',
      description: 'Delete the first document matching a JSON filter. WRITE operation; empty filters are rejected.',
      parameters: {
        database: { type: 'string', required: true, description: 'Database name' },
        collection: { type: 'string', required: true, description: 'Collection name' },
        filterJson: { type: 'string', required: true, description: 'JSON filter selecting the document to delete' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, database: { type: 'string' }, collection: { type: 'string' }, detail: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Delete from ${args.database ?? ''}.${args.collection ?? ''}`, kind: 'edit' } },
      async execute(args) {
        if (!args.database || !args.collection || !args.filterJson) return { ok: false, reason: 'database, collection, and filterJson are required.' }
        try { return await client.deleteOne(args.database as string, args.collection as string, args.filterJson) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),
  ]
}
