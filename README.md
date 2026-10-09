# dsh-tool-mongodb

[English](README.md) | [中文](README.zh.md)

MongoDB inspection and guarded write tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can check connectivity, read server and collection stats, and query documents with capped results — plus explicitly allowlisted single-document insert/update/delete operations. Writes are disabled by default.

## Install

```sh
npm install @libai168/dsh-tool-mongodb
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies, plus the bundled `mongodb` (^7.7.0) driver as a runtime dependency.

## Configuration

```yaml
- name: 'github:LJH-snow/dsh-tool-mongodb'
  config:
    # url: 'mongodb://127.0.0.1:27017'
    urlEnv: 'MONGO_URL'
    # serverSelectionTimeoutMs: 5000
    # queryTimeoutMs: 5000
    # Writes stay disabled unless both settings are present:
    # allowWrites: true
    # allowedCollections: ['orders', 'users']
```

The connection URL is resolved from `config.url` first, then the environment variable named by `urlEnv` (default `MONGO_URL`), then the default `mongodb://127.0.0.1:27017`. `queryTimeoutMs` controls the server-side `maxTimeMS` for document count/find and write operations; it defaults to 5,000 ms and is capped at 60,000 ms. Write operations require `allowWrites: true` and an exact collection name in `allowedCollections`; omitted or mismatched settings produce a refusal before the access layer is called. Do not put usable credentials in source, examples, tests, or committed configuration. URLs that embed credentials are redacted to `user:***@host` in every tool output.

## Tools

| Tool | Description | Write |
|---|---|---|
| `mongo_ping` | Verify connectivity and latency | No |
| `mongo_server_info` | Server version and database storage stats | No |
| `mongo_list_collections` | List collections (capped at 50) | No |
| `mongo_count_documents` | Count documents matching a JSON filter | No |
| `mongo_find_documents` | Find documents (max 20, serialized previews capped) | No |
| `mongo_insert_one` | Insert one document from a JSON object (disabled unless explicitly allowlisted) | Yes |
| `mongo_update_one` | Update the first matching document via `$set` (disabled unless explicitly allowlisted) | Yes |
| `mongo_delete_one` | Delete the first matching document (disabled unless explicitly allowlisted) | Yes |

## Security contract

- The connection URL may embed credentials; every output shows the redacted `user:***@host` form, and the raw URL never enters tool results.
- Filters are JSON-parsed and deep-scanned before execution. Only deterministic equality/comparison operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`) and logical operators (`$and`, `$or`, `$nor`, `$not`) are allowed; server-side JavaScript, expressions, geospatial, full-text, regular-expression, and unknown operators are rejected.
- Filter JSON is capped at 4,000 characters and 8,000 UTF-8 bytes. Insert documents are capped at 16,000 characters and 32,000 bytes; update `$set` JSON has the same 16,000-character and 32,000-byte limits.
- Database and collection names are validated (no `$`, quotes, or NUL); `system.*` collections are inaccessible.
- `mongo_find_documents` caps results at 20 documents, 2,000 characters per serialized document, and 20,000 UTF-8 bytes per response (flagged via `truncated`); BSON values are serialized to readable strings (`ObjectId(...)`, ISO dates, `<binary N bytes>`).
- Document fields whose names indicate credentials (`password`, `token`, `secret`, `apiKey`, authorization/cookie/session fields, and related variants) are rendered as `<redacted>`; inserted/updated values are never echoed back.
- Updates accept only plain field names (wrapped internally as `{ $set: ... }`); update pipelines and operator keys in `setJson` are rejected. Deletes require a constraining filter; empty filters are rejected.
- All three write tools are single-document operations marked `kind: 'edit'`, disabled by default, and gated by an exact `allowedCollections` allowlist. There are no drop, index, aggregation, or admin tools.
- The connection is created lazily with a 5-second server-selection timeout by default.

## API scope

This version covers single-database document inspection and guarded single-document writes. Aggregations, indexes, change streams, gridfs, and cluster administration are intentionally not included.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests run fully offline against a scripted access layer; no MongoDB server is needed.

## License

[MIT](LICENSE)
