import { describe, expect, it } from 'vitest'
import { MongoDbClient, MongoError, type MongoAccess } from '../src/client.ts'

function fakeAccess(overrides: Partial<MongoAccess> = {}): MongoAccess & { calls: string[] } {
  const calls: string[] = []
  const record = (label: string) => {
    calls.push(label)
  }
  return {
    calls,
    async ping(database) { record(`ping:${database}`) },
    async serverInfo(database) {
      record(`serverInfo:${database}`)
      return { version: '8.2.0', dbName: database, collections: 3, objects: 120, dataSizeBytes: 5242880 }
    },
    async listCollections() {
      record('listCollections')
      return [{ name: 'users', type: 'collection' }, { name: 'logs', type: 'timeseries' }]
    },
    async countDocuments(_db, _coll, filter) {
      record(`count:${JSON.stringify(filter)}`)
      return 7
    },
    async findDocuments(_db, _coll, filter, limit) {
      record(`find:${JSON.stringify(filter)}:${limit}`)
      return [
        { _id: { _bsontype: 'ObjectId', toHexString: () => '65f1a2b3c4d5e6f7a8b9c0d1' }, name: 'alice', createdAt: new Date('2026-10-05T00:00:00Z'), blob: new Uint8Array(4) },
        { _id: { _bsontype: 'ObjectId', toHexString: () => 'aa' }, score: { _bsontype: 'Double', toString: () => '9.5' } },
      ]
    },
    async insertOne(_db, _coll, doc) {
      record(`insert:${JSON.stringify(doc)}`)
      return { insertedId: '65f1a2b3c4d5e6f7a8b9c0d2' }
    },
    async updateOne(_db, _coll, filter, update) {
      record(`update:${JSON.stringify(filter)}:${JSON.stringify(update)}`)
      void filter
      void update
      return { matchedCount: 1, modifiedCount: 1 }
    },
    async deleteOne(_db, _coll, filter) {
      record(`delete:${JSON.stringify(filter)}`)
      return { deletedCount: 1 }
    },
    ...overrides,
  }
}

function clientFor(access: MongoAccess, url = 'mongodb://app:hushhush@db.example.invalid:27017'): MongoDbClient {
  return new MongoDbClient({ url, access })
}

describe('MongoDbClient', () => {
  it('pings with a redacted URL and never exposes credentials', async () => {
    const access = fakeAccess()
    const result = await clientFor(access).ping()

    expect(result).toMatchObject({ ok: true, latencyMs: expect.any(Number) })
    expect(result.url).toBe('mongodb://app:***@db.example.invalid:27017')
    expect(JSON.stringify(result)).not.toContain('hushhush')
    expect(access.calls[0]).toBe('ping:admin')
  })

  it('maps server info and collection listings with caps', async () => {
    const access = fakeAccess({
      listCollections: async () => Array.from({ length: 60 }, (_, index) => ({ name: `coll-${index}`, type: 'collection' })),
    })
    const fire = clientFor(access)
    const info = await fire.serverInfo('appdb')
    const collections = await fire.listCollections('appdb')

    expect(info).toEqual({ mongoVersion: '8.2.0', dbName: 'appdb', collections: 3, objects: 120, dataSizeBytes: 5242880 })
    expect(collections).toHaveLength(50)
    expect(collections[0]).toEqual({ name: 'coll-0', type: 'collection' })
  })

  it('rejects unsafe names and forbidden filter operators', async () => {
    const access = fakeAccess()
    const fire = clientFor(access)

    await expect(fire.serverInfo('$external')).rejects.toThrow('database name')
    await expect(fire.countDocuments('db', 'system.views', '{}')).rejects.toThrow('system collections')
    await expect(fire.findDocuments('db', 'users', '{"$where":"sleep(100)"}')).rejects.toThrow('$where is not allowed')
    await expect(fire.countDocuments('db', 'users', '{"a":{"$in":[{"$function":{}}]}}')).rejects.toThrow('$function is not allowed')
    await expect(fire.findDocuments('db', 'users', 'not-json')).rejects.toThrow('not valid JSON')
    await expect(fire.findDocuments('db', 'users', '[1,2]')).rejects.toThrow('must be a JSON object')
    expect(access.calls).toEqual([])
  })

  it('finds documents with serialized BSON values and size caps', async () => {
    const access = fakeAccess()
    const result = await clientFor(access).findDocuments('appdb', 'users', '{"active":true}', 2)

    expect(result.count).toBe(2)
    expect(result.items[0]).toContain('"_id":"ObjectId(65f1a2b3c4d5e6f7a8b9c0d1)"')
    expect(result.items[0]).toContain('"createdAt":"2026-10-05T00:00:00.000Z"')
    expect(result.items[0]).toContain('"blob":"<binary 4 bytes>"')
    expect(result.items[1]).toContain('"score":"9.5"')
    expect(access.calls[0]).toBe('find:{"active":true}:2')
  })

  it('inserts without echoing the document and updates via $set only', async () => {
    const access = fakeAccess()
    const fire = new MongoDbClient({ access, allowWrites: true, allowedCollections: ['users'] })
    const inserted = await fire.insertOne('appdb', 'users', '{"name":"secret-user-42","role":"ops"}')
    const updated = await fire.updateOne('appdb', 'users', '{"_id":"u1"}', '{"role":"admin"}')

    expect(inserted).toEqual({ ok: true, applied: true, database: 'appdb', collection: 'users', detail: 'insertedId=65f1a2b3c4d5e6f7a8b9c0d2' })
    expect(JSON.stringify(inserted)).not.toContain('secret-user-42')
    expect(updated).toMatchObject({ ok: true, applied: true, detail: 'matched=1 modified=1' })
    expect(access.calls[1]).toBe('update:{"_id":"u1"}:{"$set":{"role":"admin"}}')

    await expect(fire.updateOne('appdb', 'users', '{}', '{"$where":"x"}')).rejects.toThrow('plain field names')
    await expect(fire.updateOne('appdb', 'users', '{}', '{}')).rejects.toThrow('at least one field')
  })

  it('keeps writes disabled by default and never touches the access layer', async () => {
    const access = fakeAccess()
    const fire = clientFor(access)

    await expect(fire.insertOne('appdb', 'users', '{"name":"alice"}')).rejects.toThrow('disabled')
    await expect(fire.updateOne('appdb', 'users', '{"_id":"u1"}', '{"role":"admin"}')).rejects.toThrow('disabled')
    await expect(fire.deleteOne('appdb', 'users', '{"_id":"u1"}')).rejects.toThrow('disabled')
    expect(access.calls).toEqual([])
  })

  it('requires an exact allowed collection before enabling writes', async () => {
    const access = fakeAccess()
    const fire = new MongoDbClient({ access, allowWrites: true, allowedCollections: ['users'] })

    await expect(fire.insertOne('appdb', 'orders', '{"id":"o1"}')).rejects.toThrow('allowedCollections')
    expect(access.calls).toEqual([])

    await expect(fire.insertOne('appdb', 'users', '{"id":"u1"}')).resolves.toMatchObject({ ok: true, applied: true })
    expect(access.calls).toHaveLength(1)
  })

  it('deletes only with a constraining filter and reports applied state', async () => {
    const access = fakeAccess({ deleteOne: async () => ({ deletedCount: 0 }) })
    const fire = new MongoDbClient({ access, allowWrites: true, allowedCollections: ['sessions'] })
    const removed = await fire.deleteOne('appdb', 'sessions', '{"token":"t-1"}')
    expect(removed).toMatchObject({ ok: true, applied: false, detail: 'deleted=0' })
    await expect(fire.deleteOne('appdb', 'sessions', '{}')).rejects.toThrow('empty filters are rejected')
  })

  it('validates find limits and redacts malformed URLs safely', async () => {
    const access = fakeAccess()
    const fire = clientFor(access)
    await fire.findDocuments('appdb', 'users', '{}', 999)
    expect(access.calls[0]).toBe('find:{}:20')
    await fire.findDocuments('appdb', 'users', '{}', 0)
    expect(access.calls[1]).toBe('find:{}:10')

    const broken = new MongoDbClient({ url: 'not-a-url', access })
    expect(broken.getRedactedUrl()).toBe('(invalid mongodb url)')
    const srv = new MongoDbClient({ url: 'mongodb+srv://bob:pw@cluster.example.invalid/app', access })
    expect(srv.getRedactedUrl()).toBe('mongodb+srv://bob:***@cluster.example.invalid/app')
  })

  it('rejects regex, geospatial, and unknown operators while retaining safe comparisons', async () => {
    const access = fakeAccess()
    const fire = clientFor(access)

    await expect(fire.findDocuments('appdb', 'users', '{"name":{"$regex":"a"}}')).rejects.toThrow('$regex')
    await expect(fire.findDocuments('appdb', 'users', '{"location":{"$near":{"$geometry":{"type":"Point","coordinates":[0,0]}}}}')).rejects.toThrow('$near')
    await expect(fire.findDocuments('appdb', 'users', '{"$where":"sleep(100)"}')).rejects.toThrow('$where')
    await expect(fire.findDocuments('appdb', 'users', '{"$and":[{"age":{"$gte":18}},{"status":{"$eq":"active"}}]}')).resolves.toMatchObject({ count: 2 })
    expect(access.calls.at(-1)).toContain('find:')
  })

  it('enforces UTF-8 filter byte limits and redacts credential fields in results', async () => {
    const access = fakeAccess({
      findDocuments: async () => [{ password: 'do-not-show', apiKey: 'also-secret', jwt: 'jwt-secret', profile: { accessToken: 'nested-secret' }, displayName: '张三' }],
    })
    const fire = clientFor(access)
    const oversized = '{"note":"' + '中'.repeat(3000) + '"}'

    await expect(fire.findDocuments('appdb', 'users', oversized)).rejects.toThrow('bytes')
    const result = await fire.findDocuments('appdb', 'users', '{"status":"active"}')
    expect(result.items[0]).toContain('"password":"<redacted>"')
    expect(result.items[0]).toContain('"apiKey":"<redacted>"')
    expect(result.items[0]).toContain('"jwt":"<redacted>"')
    expect(result.items[0]).toContain('"accessToken":"<redacted>"')
    expect(result.items[0]).toContain('"displayName":"张三"')
  })

  it('caps returned documents even when an access layer over-returns', async () => {
    const access = fakeAccess({
      findDocuments: async () => Array.from({ length: 30 }, (_, index) => ({ index })),
    })
    const result = await clientFor(access).findDocuments('appdb', 'users', '{}', 20)

    expect(result.count).toBe(20)
    expect(result.items).toHaveLength(20)
  })

  it('forwards a bounded server-side execution timeout to document queries', async () => {
    let maxTimeMS: number | undefined
    const access = fakeAccess({
      findDocuments: async (_db, _collection, _filter, _limit, options) => {
        maxTimeMS = options?.maxTimeMS
        return []
      },
    })
    await new MongoDbClient({ access, queryTimeoutMs: 1234 }).findDocuments('appdb', 'users', '{}')

    expect(maxTimeMS).toBe(1234)
  })
})
