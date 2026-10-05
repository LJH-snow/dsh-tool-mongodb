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
    const fire = clientFor(access)
    const inserted = await fire.insertOne('appdb', 'users', '{"name":"secret-user-42","role":"ops"}')
    const updated = await fire.updateOne('appdb', 'users', '{"_id":"u1"}', '{"role":"admin"}')

    expect(inserted).toEqual({ ok: true, applied: true, database: 'appdb', collection: 'users', detail: 'insertedId=65f1a2b3c4d5e6f7a8b9c0d2' })
    expect(JSON.stringify(inserted)).not.toContain('secret-user-42')
    expect(updated).toMatchObject({ ok: true, applied: true, detail: 'matched=1 modified=1' })
    expect(access.calls[1]).toBe('update:{"_id":"u1"}:{"$set":{"role":"admin"}}')

    await expect(fire.updateOne('appdb', 'users', '{}', '{"$where":"x"}')).rejects.toThrow('plain field names')
    await expect(fire.updateOne('appdb', 'users', '{}', '{}')).rejects.toThrow('at least one field')
  })

  it('deletes only with a constraining filter and reports applied state', async () => {
    const access = fakeAccess({ deleteOne: async () => ({ deletedCount: 0 }) })
    const fire = clientFor(access)
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
})
