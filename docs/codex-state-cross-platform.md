# Codex 状态库跨系统迁移

固定 Codex 0.151.0 的 Windows 与 Linux 构建可能把相同迁移 SQL 分别按 CRLF 和 LF 嵌入。SQLx 对原始字节计算 SHA-384，因此迁来的数据库可能在启动前被拒绝，即使数据库完整、迁移版本相同。上游记录见 [openai/codex #38528](https://github.com/openai/codex/issues/38528)。不能用删除历史数据库或忽略所有迁移校验代替兼容处理。

`scripts/codex-migration-checksums.mjs` 导出 `prepareCodexChecksumCopies`，只生成六个新数据库副本，不修改源目录，不启停服务，不改变官方模型运行时，也不导入授权。

调用方须先完成以下准备：

1. 停止使用源状态库的全部进程，完成可恢复的备份；全程保持源离线。
2. 取得与实际目标 Codex 版本一致的官方 `codex-rs/state/` 下六组迁移 SQL，保留来源及文件指纹。这些文件只用于计算校验值，不被执行。
3. 用精确目标二进制在独立空状态中初始化数据库，读取六个 `_sqlx_migrations` 表，生成 `targetReference.databases`。每个数据库的记录按 version 排序，包含 version、description、success、checksum（SHA-384 十六进制）。保留实际二进制版本和指纹。
4. 指定真实、无符号链接的 sourceDirectory、sqlDirectory，以及尚不存在的 outputDirectory。源目录是该 agent 的 Codex home，而不是 OpenClaw 总状态目录。

```js
const result = await prepareCodexChecksumCopies({
  sourceDirectory, sqlDirectory, targetReference, outputDirectory,
});
```

函数先检查全部六库：迁移版本和描述须相同，每项源校验值和目标校验值都必须精确匹配同一 SQL 的 LF 或 CRLF 形式。任何真正 SQL 差异、失败迁移、版本缺失或未知校验值都会在创建输出前拒绝。目标可以是 Linux/Mac 的 LF，也可以是已独立核验的 Windows CRLF，不能凭操作系统名称猜测目标。

生成副本时包含存在的已提交 WAL，只修改 `_sqlx_migrations.checksum`。所有 schema、未知表、其他迁移字段及全部业务行均做前后审计，保留 BLOB 与 64 位整数；源主文件、WAL 和 rollback journal 的指纹必须不变。输出保持 DELETE journal，失败副本保留供检查，不被当作可用结果。

返回 `CLAWBOT_CODEX_CHECKSUM_COPIES_VERIFIED` 后，仍须在独立实例中用原官方运行时打开副本并验证模型调用。只有调用方再次确认正式环境处于维护、源未变化、恢复资料有效，才能安装已验证副本。保留原六库及其 sidecar，禁止把这一步当作跨不同迁移版本的升级器。移动到另一系统后，旧系统不得继续写同一份状态。

与校验值不同，历史记录中的 Windows 文件路径是另一类迁移问题。校验值工具不改线程路径或工作目录。若官方 `thread/read` 的完整历史读取报告缺少 rollout，可另外使用 `scripts/codex-thread-paths.mjs` 的 `prepareCodexThreadPathCopy`：提供源/目标路径格式、原 Codex home、新 Codex home、已挂载的完整历史目录，以及逐个审核过的工作目录映射。

路径工具也只生成新数据库副本。每条旧路径须严格位于原 home 的 sessions/archived_sessions 中，对应普通文件须真实存在；未知工作目录、路径穿越或符号链接都会拒绝。只更新 `threads.rollout_path` 和 `threads.cwd` 两列，其余所有表、字段与对话文件保持原样。修复后必须让官方运行时实际读取完整旧会话，而不能只凭 `includeTurns=false` 的摘要读取判断成功。

测试覆盖真实 SQLite/WAL、未知字段、BLOB、64 位整数、源保留、整组预检拒绝，以及已兼容副本和 Windows 反向目标。运行：

```sh
node --test openclaw-plugins/clawbot-bookkeeping/test/codex-migration-checksums.test.mjs
```
