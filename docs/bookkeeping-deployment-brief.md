# 微信账本助理部署方案

更新时间：2026-09-04。当前发布由 Windows 托管；Mac 接收端已停止，Vercel 和家庭网页登录尚未进入本轮范围。

## 已定方案

```text
WeChat -> OpenClaw owner-bound OpenAI GPT-5.6 Sol (official Codex harness)
  -> record_expense | prepare_expense | resolve_expense_confirmation
     -> trusted write/confirmation adapter -> ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
     (code-ready; local MCP activation still pending)
```

手机微信是输入与回复入口，腾讯 iLink 将消息交给 Windows OpenClaw。专用 `bookkeeper` 使用 OpenAI `gpt-5.6-sol`，并通过官方 `@openclaw/codex` harness 和 ChatGPT OAuth 理解账本意图；ezBookkeeping 1.6.1 在 `127.0.0.1:8180` 保存和查询本地 SQLite 数据。Gateway 也只绑定 loopback。该云端模型处理已获用户明确授权；账本请求与必要的查询结果只可进入当前已授权的 Codex 会话，本机 token、微信身份、消息 ID、SQLite 和 OpenClaw 状态不得上传。

当前实时状态（2026-09-04）：HTTP 写入、对话确认和确定性汇总已上线；ezBookkeeping 原生 MCP 仍为 `enable_mcp=false`，独立 MCP token 尚未生成。因此 `query_transactions` 是代码就绪、待交互式安全激活的能力，不得当作已通过端到端验收的功能。

配置中的正式账户为唯一可见 SGD 账户 `日常支出`，微信回执显示账本名 `日常账本`。运行时以 `openclaw-plugins/clawbot-bookkeeping/categories.mjs` 中不可变的 `CATEGORY_DEFINITIONS` 为权威分类契约，固定为 11 个一级分类、45 个二级分类；`config/expense-categories.json` 只是脱敏的导入与部署目录快照。

## 为什么采用混合接入

写入继续使用定制工具。`record_expense` 处理明确支出；`prepare_expense` 将需要澄清的完整候选存为十分钟待确认提案且不访问账本；`resolve_expense_confirmation` 只接受可信当前消息中的简短确认或取消，并在确认后复用原消息时间和同一套写入事务。它们关联可信微信元数据，以 `channel + messageId` 持久去重。短期工具绑定、待确认提案和权威回执交接均存在本地 SQLite，确认或回执发送跨插件实例时仍可恢复；回执候选不唯一则失败关闭。原生 MCP 的 `add_transaction` 没有这层消息关联和去重，因此绝不向代理开放。

读取分两条路径：

- `summarize_expenses` 通过 HTTP API 读取固定账户的支出，由代码按整数分计算今天、本周、本月、上月、今年或自定义范围内的总额、笔数、一级分类汇总和最大三笔。它可按正式分类或备注关键词过滤，不依赖模型心算。
- `ezbookkeeping__query_transactions` 在完成交互式 MCP 激活后，使用 ezBookkeeping 原生 MCP 回答最近记录、商家或备注等灵活历史问题。第一版服务级与代理级都只允许 `query_transactions`，不开放余额、分类、标签、汇率和任何写工具。默认 3 条、最多 10 条只是专用代理的回复策略，不是原生 MCP 的项目侧硬限制或安全边界。

Codex 按语义区分写入、待确认、取消和查询；插件不使用商户白名单代替语言理解。消息里出现日期、数量或“支出”不等于要写入；只有明确表达已发生消费且金额明确时才调用一次 `record_expense`。`午饭7.2吗` 先返回完整确认单，单独回复“是”才入账；新的实质消息会废弃旧提案并按新请求处理。专用模型以 `agentRuntime.id: codex` fail closed，不自动退回 Qwen 或其他模型。

## 写入与回执契约

- 默认币种 SGD、时区 `Asia/Singapore`。
- 腾讯消息时间戳由可信元数据提供，插件统一规范为 Unix 秒后提交；毫秒值会先换算为秒。
- 一条消息最多新增一笔；算式金额先合计为同一笔。
- 用户显式写“备注”时保留其后的原文；否则模型只可提炼原消息明确出现的商家、商品或用途。没有有效细节时 comment 留空，回执显示“无”。
- 备注不得超过 ezBookkeeping 的 255 字符限制，不得静默截断。

只有 ezBookkeeping 明确确认创建并返回交易 ID，才发送成功回执：

```text
记下来啦！🧾
账本：[ 日常账本 ]
支出：7.20 SGD
分类：食品酒水 - 早午晚餐
备注：无
时间：2026/09/03 16:21
```

模型必须逐字返回工具结果并立即结束本轮，不得追加思考、工具名、JSON、参数或重试说明。

| 终态 | 含义 | 用户操作 |
| --- | --- | --- |
| `created` | API 已返回交易 ID | 核对六行回执即可 |
| `failed` | 交易提交前失败，未写入 | 稍后发送一条新消息 |
| `unknown` | 请求已提交但响应不确定 | 先打开账本核对，**不要重复发送这条消费** |
| `duplicate` | 相同可信消息 ID 已被认领 | 不再次提交 |

若写入已经成功但本地去重状态未能确认，仍返回基于 API 交易 ID 的成功回执，同时记录脱敏警告；不把已确认写入误报为失败。

## 查询回复契约

`summarize_expenses` 使用 A 型信息密度：总额、笔数、所有非零一级分类和最大三笔。金额由整数分精确格式化；同额最大支出按时间倒序。示例：

```text
这个月一共花了 123.45 SGD，共 12 笔 📊

分类汇总：
食品酒水：68.20 SGD
行车交通：31.25 SGD
学习进修：24.00 SGD

最大三笔：
09/02 数码装备：24.00 SGD
09/01 超市购物：18.60 SGD
09/03 早午晚餐：15.20 SGD
```

- 无汇总记录：`这段时间还没有支出记录～`；真实回复会用实际期间替换“这段时间”。
- HTTP 汇总失败：`账本暂时连不上，本次没有读取任何数据，请稍后再试。`
- MCP 历史查询失败：使用同一条“没有读取任何数据”文案，不重试，不展示底层错误。
- 信息不足：只追问缺失金额、日期或意图，不再统一回复“记账失败，请重新发送一条新消息”。

## 所有者限定的 MCP（待本机激活）

`clawbot-bookkeeping` 注册 requester-scoped connection resolver。只有当前运行同时满足以下条件，才读取 MCP token 并在内存中构造连接：

1. 通道是 `openclaw-weixin`；
2. OpenClaw 提供非空可信 `requesterSenderId`；
3. `openclaw-weixin:<requesterSenderId>` 精确命中本机 `commands.ownerAllowFrom`。

其他发送者、定时任务、心跳、子代理、公开 Gateway 调用和缺少可信发送者信息的运行均返回 `null`，没有静态后备 MCP header。服务级 `toolFilter.include` 与代理 `tools.allow` 共同确保有效目录只包含 `query_transactions`，不包含 `add_transaction`。

API token 与 MCP token 必须分开：

- API token 未显式配置路径时，代码从 Node `homedir()`（Windows 通常为 `%USERPROFILE%`）下的 `.openclaw\secrets\ezbookkeeping-token.txt` 读取，供定制 HTTP 适配器使用；
- MCP token 使用独立的 `homedir()` 回退路径 `.openclaw\secrets\ezbookkeeping-mcp-token.txt`，只供 owner-only resolver 读取；
- MCP token 文件关闭继承并只授予当前 Windows 用户访问；
- token 不得进入 Git、OpenClaw 持久配置、提示词、日志或微信回复。

即使 MCP token 不暴露给模型，本机其他进程若窃取它仍可能调用原生 MCP 服务。这是剩余风险，也是必须保持 loopback 与受限文件权限的原因。

## Windows 服务与配置

ezBookkeeping 默认目录为 `D:\Clawbot\ezbookkeeping`，配置文件使用真实嵌套路径 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。后台任务必须登录后自动启动、隐藏运行、异常重启、没有默认执行时限，并允许在电池状态下继续。隐藏运行由精确的 Windows PowerShell 5.1 启动器实现：系统 `powershell.exe` 使用 `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden` 包装规范化后的 `ezbookkeeping.exe server run`。

先用 `-WhatIf` 预演；预演不得修改配置、计划任务、服务或 token，也不会询问密码：

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
```

实际安装及配置：

```powershell
.\scripts\install-ezbookkeeping-task.ps1
.\scripts\configure-ezbookkeeping-mcp.ps1
```

安装脚本创建 `Clawbot ezBookkeeping` 登录任务及上述精确隐藏动作；配置脚本在任何任务控制前验证同一启动器、参数和工作目录。MCP 配置脚本会：

1. 解析 `[mcp]` 并只把 `enable_mcp` 与 `mcp_allowed_remote_ips` 改为 `true` 和 `127.0.0.1`；
2. 原子创建不覆盖的时间戳备份，并原子替换配置；
3. 校验根目录中恰好一个同名任务，且 Windows PowerShell 5.1 启动器、完整隐藏参数、其中包装的账本可执行文件和工作目录完全匹配；
4. 只停止预期安装路径的 ezBookkeeping 进程，重启任务并等待 `/healthz.json` 返回 `success=true`；
5. 在控制台安全读取密码，通过现有 API token 生成独立 MCP token，并写入仅当前用户可读的文件。

中途失败会尝试恢复原配置和先前服务状态。若自动回滚也失败，脚本错误会给出应手工恢复的备份路径；恢复后再重新运行。脚本不会打印密码、请求体、Authorization header 或 token。

## 验证

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
```

动态 MCP 只由插件 manifest 和 requester-scoped resolver 声明，不得为诊断方便新增顶层 `mcp.servers` 静态连接。任何运行时配置或部署变更前，必须先执行 `WINDOWS-HANDOFF.md` 的只读属性名断言；若顶层 `mcp.servers` 下存在 `ezbookkeeping`，停止部署并另行审核移除，不能自动删除或显示其内容。该断言与账本插件自动化测试共同证明没有静态后备项，且 manifest、resolver 和代理 allowlist 只允许 `query_transactions`、源码和测试明确排除 `add_transaction`；stable-ID 插件另有独立测试。最后由所有者在微信发起真实历史查询，闭合可信上下文中的端到端证据链，并核对写入、确认、汇总和查询不会越权。

仓库秘密扫描不得跳过测试或示例目录。若从包含多个 worktree 的上级仓库运行，应只排除嵌套 `.worktrees` 副本以避免重复结果；每一条匹配仍须人工核验，不能因它位于 fixture/example 中就自动视为安全。具体命令和处置标准见 `WINDOWS-HANDOFF.md`。

## 延后事项

本轮不部署 Vercel、不开放公网端口、不实现家庭网页登录。经用户明确授权，账本请求与必要查询结果可进入当前 ChatGPT OAuth 下的 Codex 会话；不得发送到其他云端模型或服务。家庭查看功能必须另行设计安全同步、认证、授权、备份和审计，不能直接把本地 ezBookkeeping 或 MCP 暴露到公网。
