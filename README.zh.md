# dsh-tool-mongodb

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 MongoDB 巡检与受控写入 Cordis 插件。Agent 可以检查连通性、读取服务端与集合统计、按过滤器查询文档（结果限长），并执行显式的单文档插入/更新/删除。

## 安装

```sh
npm install @libai168/dsh-tool-mongodb
```

需要 peer dependency：`@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6），以及随包分发的运行时依赖 `mongodb`（^7.7.0）官方驱动。

## 配置

```yaml
- name: 'github:LJH-snow/dsh-tool-mongodb'
  config:
    # url: 'mongodb://127.0.0.1:27017'
    urlEnv: 'MONGO_URL'
    # serverSelectionTimeoutMs: 5000
```

连接 URL 依次取 `config.url`、`urlEnv` 指定的环境变量（默认 `MONGO_URL`）、默认值 `mongodb://127.0.0.1:27017`。不要把可用凭据写入源码、示例、测试或提交的配置文件。包含凭据的 URL 在所有工具输出中都会脱敏为 `user:***@host`。

## 工具

| 工具 | 说明 | 写操作 |
|---|---|---|
| `mongo_ping` | 验证连通性与延迟 | 否 |
| `mongo_server_info` | 服务端版本与数据库存储统计 | 否 |
| `mongo_list_collections` | 列出集合（上限 50） | 否 |
| `mongo_count_documents` | 按 JSON 过滤器计数 | 否 |
| `mongo_find_documents` | 查询文档（最多 20 条，序列化预览限长） | 否 |
| `mongo_insert_one` | 插入单个 JSON 文档 | 是 |
| `mongo_update_one` | 按过滤器 `$set` 更新首个匹配文档 | 是 |
| `mongo_delete_one` | 删除首个匹配文档 | 是 |

## 安全契约

- 连接 URL 可能内嵌凭据；所有输出只显示脱敏后的 `user:***@host`，原始 URL 不进入工具结果。
- 过滤器先经 JSON 解析并深度扫描再执行：直接拒绝服务端 JavaScript 运算符 `$where`、`$function`、`$accumulator`，以及 `$expr`、`$jsonSchema`、`$text`。
- 数据库与集合名校验（禁止 `$`、引号、NUL）；`system.*` 集合不可访问。
- `mongo_find_documents` 上限 20 条文档、单条序列化 2000 字符、单响应 20000 字符（超出置 `truncated`）；BSON 值序列化为可读字符串（`ObjectId(...)`、ISO 日期、`<binary N bytes>`）。
- 更新只接受普通字段名（内部包装为 `{ $set: ... }`）；拒绝更新管道与 `setJson` 中的运算符键。删除必须带约束性过滤器，空过滤器直接拒绝。
- 三个写工具均为单文档操作并标记 `kind: 'edit'`；写入值不回显（结果只含 ID 与计数）。不提供 drop、索引、聚合、管理类工具。
- 连接惰性创建，服务端选择超时默认 5 秒。

## API 范围

当前版本覆盖单库文档巡检与受控单文档写入。聚合管道、索引、change stream、GridFS 与集群管理有意未包含。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试通过脚本化访问层完全离线运行，不需要真实 MongoDB 服务。

## 许可证

[MIT](LICENSE)
