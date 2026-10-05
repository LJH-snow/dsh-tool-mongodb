/** Default MongoDB access layer backed by the official mongodb driver.
 * The connection is created lazily so importing this module never opens a socket. */

import { MongoClient } from 'mongodb'
import type { MongoAccess } from './client.js'

export class NodeMongoAccess implements MongoAccess {
  private readonly url: string
  private readonly serverSelectionTimeoutMs: number
  private readonly client: MongoClient
  private connectPromise?: Promise<void>

  constructor(url: string, serverSelectionTimeoutMs = 5000) {
    this.url = url
    this.serverSelectionTimeoutMs = serverSelectionTimeoutMs
    this.client = new MongoClient(url, { serverSelectionTimeoutMS: serverSelectionTimeoutMs })
  }

  private async ready(): Promise<void> {
    if (!this.connectPromise) {
      // Surface connection failures through operation rejections instead of an
      // unhandled 'serverSelectionError' event crashing the host.
      this.client.on('error', () => {})
      this.connectPromise = this.client.connect().then(() => undefined)
    }
    await this.connectPromise
  }

  async ping(database: string): Promise<void> {
    await this.ready()
    await this.client.db(database).command({ ping: 1 })
  }

  async serverInfo(database: string): Promise<{ version: string; dbName: string; collections: number; objects: number; dataSizeBytes: number }> {
    await this.ready()
    const db = this.client.db(database)
    const build = await db.command({ buildInfo: 1 }) as { version?: string }
    const stats = await db.command({ dbStats: 1 }) as { db?: string; collections?: number; objects?: number; dataSize?: number }
    return {
      version: String(build.version ?? ''),
      dbName: String(stats.db ?? database),
      collections: Number(stats.collections ?? 0),
      objects: Number(stats.objects ?? 0),
      dataSizeBytes: Number(stats.dataSize ?? 0),
    }
  }

  async listCollections(database: string): Promise<Array<{ name: string; type: string }>> {
    await this.ready()
    const items = await this.client.db(database).listCollections().toArray()
    return items.map(item => ({ name: item.name, type: item.type ?? 'collection' }))
  }

  async countDocuments(database: string, collection: string, filter: Record<string, unknown>): Promise<number> {
    await this.ready()
    return await this.client.db(database).collection(collection).countDocuments(filter)
  }

  async findDocuments(database: string, collection: string, filter: Record<string, unknown>, limit: number): Promise<unknown[]> {
    await this.ready()
    return await this.client.db(database).collection(collection).find(filter, { limit }).toArray()
  }

  async insertOne(database: string, collection: string, doc: Record<string, unknown>): Promise<{ insertedId: string }> {
    await this.ready()
    const result = await this.client.db(database).collection(collection).insertOne(doc)
    return { insertedId: String(result.insertedId) }
  }

  async updateOne(database: string, collection: string, filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }> {
    await this.ready()
    const result = await this.client.db(database).collection(collection).updateOne(filter, update)
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }
  }

  async deleteOne(database: string, collection: string, filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    await this.ready()
    const result = await this.client.db(database).collection(collection).deleteOne(filter)
    return { deletedCount: result.deletedCount }
  }
}
