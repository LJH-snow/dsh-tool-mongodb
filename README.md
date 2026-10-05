# dsh-tool-mongodb

[English](README.md) | [中文](README.zh.md)

MongoDB inspection and guarded write tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can check connectivity, read server and collection stats, and query documents with capped results — plus explicit single-document insert/update/delete operations.

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
```

The connection URL is resolved from `config.url` first, then the environment variable named by `urlEnv` (default: `MONGO_URL`), then the default `mongodb://127.0.0.1:27017`. Do not put usable credentials in source, examples, tests, or committed configuration. URLs that embed credentials are redacted to `user:***@host` in every tool output.

## Tools

| Tool | Description | Write |
|---|---|---|
| `mongo_ping` | Verify connectivity and latency | No |
| `mongo_server_info` | Server version and database storage stats | No |
| `mongo_list_collections` | List collections (capped at 50) | No |
| `mongo_count_documents` | Count documents matching a JSON filter | No |
| `mongo_find_documents` | Find documents (max 20, serialized previews capped) | No |
| `mongo_insert_one` | Insert one document from a JSON object | Yes |
| `mongo_update_one` | Update the first matching document via `$set` | Yes |
| `mongo_delete_one` | Delete the first matching document | Yes |

## Security contract

- The connection URL may embed credentials; every output shows the redacted `user:***@host` form, and the raw URL never enters tool results.
- Filters are JSON-parsed and deep-scanned before execution: the server-side-JavaScript operators `$where`, `$function`, and `$accumulator`, plus `$expr`, `$jsonSchema`, and `$text`, are rejected outright.
- Database and collection names are validated (no `$`, quotes, or NUL); `system.*` collections are inaccessible.
- `mongo_find_documents` caps results at 20 documents, 2,000 characters per serialized document, and 20,000 characters per response (flagged via `truncated`); BSON values are serialized to readable strings (`ObjectId(...)`, ISO dates, `<binary N bytes>`).
- Updates accept only plain field names (wrapped internally as `{ $set: ... }`); update pipelines and operator keys in `setJson` are rejected. Deletes require a constraining filter; empty filters are rejected.
- All three write tools are single-document operations marked `kind: 'edit'`; inserted/updated values are never echoed back (results carry only IDs and counts). There are no drop, index, aggregation, or admin tools.
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
