import { describe, expect, it } from 'vitest'
import { MongoDbClient, type MongoAccess } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function fakeAccess(handlers: {
  find?: (filter: Record<string, unknown>, limit: number) => Promise<unknown[]>
  insert?: (doc: Record<string, unknown>) => Promise<{ insertedId: string }>
  update?: (filter: Record<string, unknown>, update: Record<string, unknown>) => Promise<{ matchedCount: number; modifiedCount: number }>
  remove?: (filter: Record<string, unknown>) => Promise<{ deletedCount: number }>
}): MongoAccess & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async ping() { calls.push('ping') },
    async serverInfo(database) { calls.push(`info:${database}`); return { version: '8.2.0', dbName: database, collections: 1, objects: 3, dataSizeBytes: 1024 } },
    async listCollections() { calls.push('listCollections'); return [{ name: 'users', type: 'collection' }] },
    async countDocuments(_db, _coll, filter) { calls.push(`count:${JSON.stringify(filter)}`); return 1 },
    async findDocuments(_db, _coll, filter, limit) { calls.push(`find:${JSON.stringify(filter)}:${limit}`); return handlers.find ? handlers.find(filter, limit) : [] },
    async insertOne(_db, _coll, doc) { calls.push(`insert:${JSON.stringify(doc)}`); return handlers.insert ? handlers.insert(doc) : { insertedId: 'id-1' } },
    async updateOne(_db, _coll, filter, update) { calls.push(`update:${JSON.stringify(filter)}`); return handlers.update ? handlers.update(filter, update) : { matchedCount: 0, modifiedCount: 0 } },
    async deleteOne(_db, _coll, filter) { calls.push(`delete:${JSON.stringify(filter)}`); return handlers.remove ? handlers.remove(filter) : { deletedCount: 0 } },
  }
}

describe('dsh-tool-mongodb tools', () => {
  it('registers the MongoDB tool set', () => {
    expect(createTools(new MongoDbClient({ access: fakeAccess({}) })).map(tool => tool.name)).toEqual([
      'mongo_ping',
      'mongo_server_info',
      'mongo_list_collections',
      'mongo_count_documents',
      'mongo_find_documents',
      'mongo_insert_one',
      'mongo_update_one',
      'mongo_delete_one',
    ])
  })

  it('renders server info, collections, and documents', () => {
    const tools = createTools(new MongoDbClient({ access: fakeAccess({}) }))
    const info = tools.find(item => item.name === 'mongo_server_info')!
    const infoView = info.output.render({}, { ok: true, mongoVersion: '8.2.0', dbName: 'appdb', collections: 3, objects: 120, dataSizeBytes: 5242880 }) as Array<{ text: string }>
    expect(infoView[0].text).toContain('MongoDB 8.2.0 db=appdb collections=3 objects=120 dataSize=5.0MB')

    const collections = tools.find(item => item.name === 'mongo_list_collections')!
    const collectionsView = collections.output.render({}, { found: true, items: [{ name: 'users', type: 'collection' }] }) as Array<{ text: string }>
    expect(collectionsView[0].text).toContain('users (collection)')

    const find = tools.find(item => item.name === 'mongo_find_documents')!
    const findView = find.output.render({}, { found: true, items: ['{"name":"alice"}'], count: 1, truncated: false }) as Array<{ text: string }>
    expect(findView[0].text).toContain('1. {"name":"alice"}')

    const emptyView = find.output.render({}, { found: true, items: [], count: 0, truncated: false }) as Array<{ text: string }>
    expect(emptyView[0].text).toContain('No documents matched')
  })

  it('marks insert, update, and delete as edits and renders write results', () => {
    const tools = createTools(new MongoDbClient({ access: fakeAccess({}) }))
    for (const [name, args] of Object.entries({
      mongo_insert_one: { database: 'd', collection: 'c', docJson: '{}' },
      mongo_update_one: { database: 'd', collection: 'c', filterJson: '{}', setJson: '{"a":1}' },
      mongo_delete_one: { database: 'd', collection: 'c', filterJson: '{"a":1}' },
    })) {
      const tool = tools.find(item => item.name === name)!
      expect(tool.presentCall(args)).toMatchObject({ kind: 'edit' })
    }
    expect(tools.find(item => item.name === 'mongo_server_info')!.presentCall({ database: 'd' })).toMatchObject({ kind: 'read' })
    expect(tools.find(item => item.name === 'mongo_find_documents')!.presentCall({ database: 'd', collection: 'c' })).toMatchObject({ kind: 'search' })

    const update = tools.find(item => item.name === 'mongo_update_one')!
    const appliedView = update.output.render({}, { ok: true, applied: true, database: 'd', collection: 'c', detail: 'matched=1 modified=1' }) as Array<{ text: string }>
    expect(appliedView[0].text).toContain('Applied on d.c: matched=1 modified=1')
    const missedView = update.output.render({}, { ok: true, applied: false, database: 'd', collection: 'c', detail: 'matched=0 modified=0' }) as Array<{ text: string }>
    expect(missedView[0].text).toContain('No document matched')
  })

  it('runs insert and find end to end without echoing the inserted document', async () => {
    const access = fakeAccess({
      insert: async doc => {
        void doc
        return { insertedId: 'generated-id-9' }
      },
      find: async () => [{ _id: 'generated-id-9', status: 'stored' }],
    })
    const tools = createTools(new MongoDbClient({ url: 'mongodb://db.example.invalid', access, allowWrites: true, allowedCollections: ['users'] }))

    const insert = tools.find(item => item.name === 'mongo_insert_one')!
    const insertResult = await insert.execute({ database: 'appdb', collection: 'users', docJson: '{"payload":"super-secret-doc-value"}' })
    expect(insertResult).toMatchObject({ ok: true, applied: true, detail: 'insertedId=generated-id-9' })
    expect(JSON.stringify(insertResult)).not.toContain('super-secret-doc-value')

    const find = tools.find(item => item.name === 'mongo_find_documents')!
    const findResult = await find.execute({ database: 'appdb', collection: 'users', filterJson: '{"status":"stored"}', limit: 5 })
    expect(findResult).toMatchObject({ found: true, count: 1 })
    expect(JSON.stringify(findResult)).toContain('generated-id-9')
  })

  it('returns a stable refusal for write tools when writes are not configured', async () => {
    const access = fakeAccess({})
    const tools = createTools(new MongoDbClient({ access }))
    const insert = tools.find(item => item.name === 'mongo_insert_one')!
    const update = tools.find(item => item.name === 'mongo_update_one')!
    const remove = tools.find(item => item.name === 'mongo_delete_one')!

    await expect(insert.execute({ database: 'appdb', collection: 'users', docJson: '{"name":"alice"}' })).resolves.toMatchObject({ ok: false, applied: false })
    await expect(update.execute({ database: 'appdb', collection: 'users', filterJson: '{"_id":"u1"}', setJson: '{"role":"admin"}' })).resolves.toMatchObject({ ok: false, applied: false })
    await expect(remove.execute({ database: 'appdb', collection: 'users', filterJson: '{"_id":"u1"}' })).resolves.toMatchObject({ ok: false, applied: false })
    expect(access.calls).toEqual([])
  })

  it('does not return raw driver write errors containing document values', async () => {
    const access = fakeAccess({
      insert: async () => { throw new Error('E11000 duplicate key error dup key: { email: "secret@example.com" }') },
    })
    const tools = createTools(new MongoDbClient({ access, allowWrites: true, allowedCollections: ['users'] }))
    const insert = tools.find(item => item.name === 'mongo_insert_one')!
    const result = await insert.execute({ database: 'appdb', collection: 'users', docJson: '{"email":"secret@example.com"}' })
    expect(result).toMatchObject({ ok: false, applied: false, reason: expect.stringContaining('database rejected') })
    expect(JSON.stringify(result)).not.toContain('secret@example.com')
    expect(JSON.stringify(result)).not.toContain('E11000')
  })
})
