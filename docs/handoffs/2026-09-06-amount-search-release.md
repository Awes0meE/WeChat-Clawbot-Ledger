# 金额查询发布交接（2026-09-06）

用户批准发布已完成的精确金额查询功能。没有为官方文档科普修改代码，也没有启用原生 MCP 或网页识别模型。

## 发布与验收范围

- 代码提交与生产 immutable release：`1d487943433869d0422f1bf4446fd046717c3647`，`feat(bookkeeping): add exact amount expense search`。
- 分支：`feat/amount-transaction-search`；发布前本地与远端 `main` 同为 `e3af81be643daf44f7282eb81c2c4b0a53a2be76`，功能提交干净。
- 已完成 TDD、独立审查以及完整 bookkeeping 625/625；金额查询专项 91/91、发布脚本专项 55/55、stable-ID build 与 3/3。均使用合成数据；没有将仓库单元测试指向正式账本。
- 新发布包 38,396 个文件，发布与切换过程中完整 manifest 哈希、ACL 校验通过。旧 `0e7c2d7f1f0369552d17d054e2ef24b75be7a482` 同样经过完整校验并保留。
- 既有 publisher 切换 release；随后受控官方 config patch 仅向 bookkeeper 的原五项 `tools.allow` 末尾追加 `find_expenses`。配置预演、前后完整比较、受限备份与 patch 清理均通过。
- 切换后的 Gateway、微信 channel、两个插件、Codex harness 和模型检查通过；当前 Gateway 启动日志证明一个 managed session-memory hook 已注册，三个 hook 文件哈希一致，无 loader 失败。日志只在本机内存中核验，没有输出原文。
- 新 release 的本机矩阵 14/14，通过公网 token/缓存/安全检查及作品集基线比较。没有额外重跑登录限速实验，没有重启 ezBookkeeping 或 Tunnel。

## 真实只读金额查询

未指定日期时，`find_expenses` 在固定 SGD 支出账户内查询全部历史。金额 `3.36` 转换成整数分 `336`，经 HTTP `amount_filter=eq:336` 精确筛选；默认显示最近三笔，有更多时明确提示。

1. 发布后的只读 probe 使用新包中的 adapter 与 formatter，经固定 loopback GET 请求验证金额筛选、响应结构与格式化结果。
2. 发送前保存账户、分类、交易的规范化 SHA-256 及 formatter 摘要；原始 API 内容仅在本机 RAM 处理。
3. 所有者在原微信聊天中仅发送一次原金额查询，确认只有一条正常查询结果、显示 1 笔 3.36 SGD。
4. 查询后再次只读核验，匹配仍为一笔且没有后续页，三个数据哈希及 formatter 摘要完全相同。本次没有创建、修改或删除交易。

用户确认用于证明微信收到的条数与显示结果；API 哈希用于证明观察窗口内账本数据未变。不能把 API probe 单独当作微信工具调用或送达证据。

补充只读观察使用 OpenClaw 原生 SQLite，不生成或导出 JSONL：以真实 API 基线的本机毫秒时间为起点，窗口包含一个 session 的六个新增事件，无 transcript rewrite；其中有一条新用户消息、一次直接 `find_expenses` 调用和一个终态回复，终态文本的 SHA-256 与当前 formatter 一致。窗口首部有原生 `reset` 上下文边界，通用观察 helper 未完成完整父链与绑定关联复验；不把这项局部观察称为完整镜像链验证，也不将 helper 的拒绝解释成查询功能失败。未读取或输出交易正文、身份、SQL 数据行或日志原文。

## 配置与回滚

生产保持 `127.0.0.1:8888`，测试实例仍为独立 `18888`，Gateway 保持 loopback。继续固定官方 Codex harness 和 `gpt-5.6-sol`，保留所有者白名单。MCP 仍关闭，未创建 MCP token，未改变 Cloudflare Tunnel、DNS、规则或作品集路由。

现行工具顺序为 `record_expense`、`prepare_expense`、`resolve_expense_confirmation`、`summarize_expenses`、`ezbookkeeping__query_transactions`、`find_expenses`。

回滚必须同时处理 release 路径与工具权限：恢复经验证且对应目标状态的受限完整配置备份，或者用受控 patch 移除 `find_expenses`；随后核对路径，并使用 publisher 切旧 release 与复验。权限 patch 前的备份制作于新包切换之后，单独恢复它只回退权限，不能回退代码。仅切路径则不会移除新增 allowlist 项。保留旧包和受限备份，不覆盖 immutable release，不恢复数据库。

旧的真实平台同一 message ID 重放仍未验证，`deploymentComplete=false`。本次金额查询验收不替代这个旧缺口，也不要求重复发送消费消息来模拟平台重放。
