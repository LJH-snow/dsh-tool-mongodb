# dsh-tool-mongodb 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-mongodb` |
| 定位 | DeepSeek Harness 的 MongoDB 巡检与受控写入插件 |
| 版本 | v0.1.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| 驱动 | 官方 `mongodb` ^7.7.0（惰性连接，服务端选择超时默认 5 秒） |
| 认证 | 连接 URL 内嵌凭据，输出一律脱敏为 `user:***@host` |

### 1.1 目录

```text
src/client.ts   MongoDbClient + MongoAccess 接口：过滤器安全扫描、限长、BSON 序列化、URL 脱敏
src/driver.ts   NodeMongoAccess：官方驱动适配（惰性连接、错误收敛）
src/index.ts    8 个 defineTool 定义与插件 apply
 tests/*.spec.ts 离线访问层脚本测试与工具端到端测试
examples/cordis.yml  dsh 组合配置示例
```

## 2. 技术决策

### 2.1 访问层抽象

- `MongoAccess` 定义 ping/serverInfo/listCollections/countDocuments/findDocuments/insertOne/updateOne/deleteOne 八个显式方法；测试注入脚本化假实现即可完全离线运行，不引入 mongodb-memory-server。
- `NodeMongoAccess` 惰性创建连接（首次操作才 connect），并收敛客户端 `error` 事件，避免未处理异常击穿宿主进程。

### 2.2 过滤器安全

- filterJson/docJson/setJson 均为 JSON 字符串，解析后必须为对象；filter 限 4000 字符、set 限 16000、doc 限 16000。
- 过滤器深度遍历，命中 `FORBIDDEN_FILTER_OPERATORS`（$where、$function、$accumulator、$expr、$jsonSchema、$text）即拒绝并报出路径。
- 更新只接受普通字段名并内部包装 `{ $set: ... }`；拒绝更新管道与 `$` 开头的键。删除必须带非空过滤器。
- 数据库/集合名校验 `NAME_PATTERN`（禁 `$`、引号、NUL，长度 ≤200），`system.*` 集合返回 403。

### 2.3 序列化与限长

- BSON 值按 `_bsontype` 结构化识别（不 import 驱动类型）：ObjectId → `ObjectId(hex)`，Long/Decimal128 → 字符串，Binary/UUID → `<binary>`，Date → ISO；递归序列化后 JSON 字符串化。
- find 上限 20 条（默认 10），单条序列化 2000 字符、响应总量 20000 字符，超限置 `truncated`。
- URL 输出前经 `getRedactedUrl()` 脱敏（密码替换 `***`，支持 mongodb+srv，解析失败显示占位符）。

### 2.4 工具范围

- 读：ping、server_info、list_collections、count_documents、find_documents。
- 写：insert_one、update_one、delete_one，单文档、显式参数、标记 `kind: 'edit'`，写入值不回显。
- 不做：聚合、索引、change stream、GridFS、集群管理、多文档批量写。

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用脚本化假访问层覆盖：PING 与 URL 脱敏（含 srv 与非法 URL）、服务端信息映射、集合列表上限、危险运算符/名称/JSON 形状拒绝、BSON 序列化、find 限幅与总量截断、插入不回显、$set 白名单、删除空过滤器拒绝、工具注册、render、写操作 kind 与端到端执行。

## 4. 后续方向

- 增加 index 只读巡检（listIndexes）与聚合只读工具（受控 stage 白名单）。
- 增加批量写入的受控版本（显式文档清单，单次上限）。
- 跟随驱动大版本变化补充兼容性测试。
