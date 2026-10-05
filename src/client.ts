/** MongoDB client with an injectable access layer for offline tests. Filters are
 * JSON-parsed and scanned for server-side-JavaScript operators before any query
 * runs; reads are capped and written values are never echoed back. */

import { NodeMongoAccess } from './driver.js'

export interface MongoAccess {
  ping(database: string): Promise<void>
  serverInfo(database: string): Promise<{ version: string; dbName: string; collections: number; objects: number; dataSizeBytes: number }>
  listCollections(database: string): Promise<Array<{ name: string; type: string }>>
  countDocuments(database: string, collection: string, filter: Record<string, unknown>): Promise<number>
  findDocuments(database: string, collection: string, filter: Record<string, unknown>, limit: number): Promise<unknown[]>
  insertOne(database: string, collection: string, doc: Record<string, unknown>): Promise<{ insertedId: string }>
  updateOne(database: string, collection: string, filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }>
  deleteOne(database: string, collection: string, filter: Record<string, unknown>): Promise<{ deletedCount: number }>
}

export interface MongoDbClientOptions {
  /** MongoDB connection URL, for example mongodb://127.0.0.1:27017. Credentials are redacted in outputs. */
  url?: string
  /** Server selection timeout in milliseconds (default 5000). */
  serverSelectionTimeoutMs?: number
  /** Access layer override; used by tests to run fully offline. */
  access?: MongoAccess
}

export class MongoError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
  ) {
    super(message)
    this.name = 'MongoError'
  }
}

export interface MongoServerInfo {
  mongoVersion: string
  dbName: string
  collections: number
  objects: number
  dataSizeBytes: number
}

export interface MongoCollectionInfo {
  name: string
  type: string
}

export interface MongoFindResult {
  items: string[]
  count: number
  truncated: boolean
}

export interface MongoWriteResult {
  ok: boolean
  applied: boolean
  database: string
  collection: string
  detail: string
}

const FILTER_LIMIT = 4000
const SET_LIMIT = 16000
const DOC_LIMIT = 16000
const ITEM_STRING_LIMIT = 2000
const FIND_RESULT_TOTAL_LIMIT = 20000
const FIND_LIMIT_MAX = 20
const LIST_LIMIT = 50
const NAME_LIMIT = 200

/** Operators that evaluate server-side JavaScript or trigger special scan modes. */
const FORBIDDEN_FILTER_OPERATORS = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$expr',
  '$jsonSchema',
  '$text',
])

const NAME_PATTERN = /^[^$"\0]{1,200}$/

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

/** BSON values arrive as class instances; recognize them structurally so the
 * client layer stays decoupled from the driver package. */
function serializeValue(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`
  if (typeof value === 'object') {
    const bsonType = (value as { _bsontype?: string })._bsontype
    if (bsonType === 'ObjectId') return `ObjectId(${String((value as { toHexString?: () => string }).toHexString?.() ?? value)})`
    if (bsonType === 'Long' || bsonType === 'Decimal128' || bsonType === 'Int32' || bsonType === 'Double') return String(value)
    if (bsonType === 'Binary' || bsonType === 'UUID') return `<binary>`
    if (Array.isArray(value)) return value.map(item => serializeValue(item))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = serializeValue(item)
    return out
  }
  return String(value)
}

export class MongoDbClient {
  private readonly url: string
  private readonly serverSelectionTimeoutMs: number
  private readonly access: MongoAccess

  constructor(options: MongoDbClientOptions = {}) {
    this.url = options.url ?? 'mongodb://127.0.0.1:27017'
    this.serverSelectionTimeoutMs = options.serverSelectionTimeoutMs ?? 5000
    this.access = options.access ?? new NodeMongoAccess(this.url, this.serverSelectionTimeoutMs)
  }

  getRedactedUrl(): string {
    try {
      const parsed = new URL(this.url)
      const auth = parsed.username ? `${parsed.username}:***@` : ''
      return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`
    } catch {
      return '(invalid mongodb url)'
    }
  }

  private validateDatabase(database: string): void {
    if (!NAME_PATTERN.test(database)) throw new MongoError('database name must be 1-200 characters without $ or quotes.', 400)
  }

  private validateCollection(collection: string): void {
    if (!NAME_PATTERN.test(collection)) throw new MongoError('collection name must be 1-200 characters without $ or quotes.', 400)
    if (collection.startsWith('system.')) throw new MongoError('system collections are not accessible through this plugin.', 403)
  }

  private parseJsonObject(raw: unknown, label: string, limit: number): Record<string, unknown> {
    if (typeof raw !== 'string' || !raw.trim()) throw new MongoError(`${label} is required and must be a JSON object.`, 400)
    if (raw.length > limit) throw new MongoError(`${label} exceeds ${limit} characters.`, 400)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      throw new MongoError(`${label} is not valid JSON.`, 400)
    }
    const record = asPlainObject(parsed)
    if (!record) throw new MongoError(`${label} must be a JSON object.`, 400)
    return record
  }

  private assertFilterSafe(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((item, index) => this.assertFilterSafe(item, `${path}[${index}]`))
      return
    }
    const record = asPlainObject(node)
    if (!record) return
    for (const [key, item] of Object.entries(record)) {
      if (key.startsWith('$') && FORBIDDEN_FILTER_OPERATORS.has(key)) {
        throw new MongoError(`filter operator ${key} is not allowed (path ${path}).`, 400)
      }
      this.assertFilterSafe(item, path ? `${path}.${key}` : key)
    }
  }

  parseFilter(raw: unknown): Record<string, unknown> {
    const filter = this.parseJsonObject(raw, 'filterJson', FILTER_LIMIT)
    this.assertFilterSafe(filter, '')
    return filter
  }

  parseSetDoc(raw: unknown): Record<string, unknown> {
    const setDoc = this.parseJsonObject(raw, 'setJson', SET_LIMIT)
    for (const key of Object.keys(setDoc)) {
      if (key.startsWith('$')) throw new MongoError('setJson must contain plain field names; only $set is applied.', 400)
    }
    return setDoc
  }

  async ping(): Promise<{ ok: boolean; url: string; latencyMs: number }> {
    const start = Date.now()
    await this.access.ping('admin')
    return { ok: true, url: this.getRedactedUrl(), latencyMs: Date.now() - start }
  }

  async serverInfo(database: string): Promise<MongoServerInfo> {
    this.validateDatabase(database)
    const info = await this.access.serverInfo(database)
    return {
      mongoVersion: info.version,
      dbName: info.dbName,
      collections: info.collections,
      objects: info.objects,
      dataSizeBytes: info.dataSizeBytes,
    }
  }

  async listCollections(database: string): Promise<MongoCollectionInfo[]> {
    this.validateDatabase(database)
    const items = await this.access.listCollections(database)
    return items
      .map(item => ({ name: clampText(item.name, NAME_LIMIT), type: item.type || 'collection' }))
      .slice(0, LIST_LIMIT)
  }

  async countDocuments(database: string, collection: string, filterJson: unknown): Promise<{ count: number }> {
    this.validateDatabase(database)
    this.validateCollection(collection)
    const filter = this.parseFilter(filterJson)
    return { count: await this.access.countDocuments(database, collection, filter) }
  }

  async findDocuments(database: string, collection: string, filterJson: unknown, limit?: number): Promise<MongoFindResult> {
    this.validateDatabase(database)
    this.validateCollection(collection)
    const filter = this.parseFilter(filterJson)
    const capped = Math.min(Math.max(Math.trunc(Number(limit) || 10), 1), FIND_LIMIT_MAX)
    const docs = await this.access.findDocuments(database, collection, filter, capped)
    const items: string[] = []
    let totalBytes = 0
    let truncated = false
    for (const doc of docs) {
      const serialized = JSON.stringify(serializeValue(doc)) ?? 'null'
      if (totalBytes + serialized.length > FIND_RESULT_TOTAL_LIMIT) {
        truncated = true
        break
      }
      totalBytes += serialized.length
      items.push(clampText(serialized, ITEM_STRING_LIMIT))
    }
    return { items, count: items.length, truncated }
  }

  async insertOne(database: string, collection: string, docJson: unknown): Promise<MongoWriteResult> {
    this.validateDatabase(database)
    this.validateCollection(collection)
    const doc = this.parseJsonObject(docJson, 'docJson', DOC_LIMIT)
    const result = await this.access.insertOne(database, collection, doc)
    return { ok: true, applied: true, database, collection, detail: `insertedId=${result.insertedId}` }
  }

  async updateOne(database: string, collection: string, filterJson: unknown, setJson: unknown): Promise<MongoWriteResult> {
    this.validateDatabase(database)
    this.validateCollection(collection)
    const filter = this.parseFilter(filterJson)
    const setDoc = this.parseSetDoc(setJson)
    if (!Object.keys(setDoc).length) throw new MongoError('setJson must contain at least one field.', 400)
    const result = await this.access.updateOne(database, collection, filter, { $set: setDoc })
    return {
      ok: true,
      applied: result.modifiedCount > 0,
      database,
      collection,
      detail: `matched=${result.matchedCount} modified=${result.modifiedCount}`,
    }
  }

  async deleteOne(database: string, collection: string, filterJson: unknown): Promise<MongoWriteResult> {
    this.validateDatabase(database)
    this.validateCollection(collection)
    const filter = this.parseFilter(filterJson)
    if (!Object.keys(filter).length) throw new MongoError('filterJson must constrain the deletion; empty filters are rejected.', 400)
    const result = await this.access.deleteOne(database, collection, filter)
    return { ok: true, applied: result.deletedCount > 0, database, collection, detail: `deleted=${result.deletedCount}` }
  }
}
