# Clawbot

Clawbot 是一个私有、Windows 托管的微信个人账本助理。当前发布只运行在 Windows：

```text
WeChat -> OpenClaw owner-bound OpenAI GPT-5.6 Sol (official Codex harness)
  -> record_expense | prepare_expense | resolve_expense_confirmation
     -> trusted write/confirmation adapter -> ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
     (code-ready; local MCP activation still pending)
```

仓库保存可复现源码、测试、文档和脱敏配置模板。真实凭据、微信身份、消息正文、OpenClaw 状态和账本数据只留在 Windows 主机。原 Mac 接收端已停止，不应与 Windows iLink 接收端同时运行。

## 当前基线

以下基线整理于 2026-09-04；接手时仍须重新探测实时状态。

| 组件 | 当前约束 |
| --- | --- |
| OpenClaw | 2026.8.2；Gateway 只绑定 `127.0.0.1:18789` |
| 微信入口 | 腾讯 iLink；只路由已绑定的所有者账号到专用 `bookkeeper` |
| 助理模型 | OpenAI `gpt-5.6-sol`；官方 `@openclaw/codex` 2026.8.2 harness；ChatGPT OAuth；thinking low |
| 账本 | ezBookkeeping 1.6.1；只绑定 `127.0.0.1:8180` |
| 账户与币种 | 唯一可见 SGD 账户 `日常支出`；回执显示 `日常账本` |
| 分类 | 运行时以 `openclaw-plugins/clawbot-bookkeeping/categories.mjs` 的不可变 `CATEGORY_DEFINITIONS` 为权威契约，固定为 11 个一级、45 个二级分类 |
| 专用代理 allowlist | `record_expense`、`prepare_expense`、`resolve_expense_confirmation`、`summarize_expenses`、`ezbookkeeping__query_transactions` |
| 灵活历史查询 | 代码与最小权限契约已就绪；截至 2026-09-04，本机 `enable_mcp=false` 且独立 MCP token 尚未生成，因此尚未上线 |

## 助理行为

### 写入支出

Codex 理解金额、正式分类和语义备注；程序负责可信微信消息关联、字段校验、写入和去重。一条入站消息最多新增一笔支出，去重键为可信 `channel + messageId`，而不是消息正文。

- 默认 SGD、`Asia/Singapore`。
- 微信时间戳被规范为 Unix 秒后提交给 ezBookkeeping；毫秒输入会先除以 1000。
- 显式“备注”后的原文优先；否则模型只可提炼消息中明确出现的商家、商品或用途，不得补充事实。
- Codex 判断是否为本人已发生支出；插件不再用商户白名单或大量中文句式取代模型。插件仍硬性要求当前可信消息中只有一个相关金额、金额与工具参数一致，并拦截明显疑问的直接写入。
- `午饭7.2吗` 这类信息先由 `prepare_expense` 保存十分钟待确认提案并返回完整表单，绝不访问账本。用户单独回复“是”才由 `resolve_expense_confirmation` 使用原消息的金额、分类、备注和时间入账；回复“不是”则取消。
- 每个所有者会话最多一张待确认单。新的实质消息会替换旧上下文并使旧确认单失效；重复确认不会产生第二笔。状态保存在本地 SQLite，Gateway 重启或上下文压缩不会丢失。
- 写入成功后返回固定六行回执；例如：

```text
记下来啦！🧾
账本：[ 日常账本 ]
支出：7.20 SGD
分类：食品酒水 - 早午晚餐
备注：无
时间：2026/09/03 16:21
```

写入结果有明确的终态语义：

- `created`：ezBookkeeping 已明确返回交易 ID，才允许发送成功回执。
- `failed`：失败发生在提交交易之前，回复“本次没有写入任何数据”，稍后可重新发送新消息。
- `unknown`：交易请求已经发出，但响应结果不确定；必须先打开账本核对，**不要重复发送这条消费**。
- 同一消息重放：插件说明已处理、失败或状态未确认，并保证不重复提交。

### 查询支出

- `summarize_expenses` 处理今天、本周、本月、上月、今年或自定义日期范围的精确汇总，可再按正式分类或备注关键词筛选。金额以整数分累加，返回总额、笔数、所有非零一级分类和最大三笔。
- `ezbookkeeping__query_transactions` 处理“最近三笔是什么”“上月在某商家买过什么”等灵活历史查询。默认 3 条、最多 10 条是专用代理的回复策略，不是原生 MCP 上由项目包装器强制执行的安全上限；安全边界仍是 owner-only resolver 和工具 allowlist。
- 上述灵活历史查询是已实现但未激活的能力。在用户于可见终端运行 `scripts/configure-ezbookkeeping-mcp.ps1` 并完成密码输入前，不得宣称“最近几笔/商家明细”查询已可用；当前已上线的查账能力是 `summarize_expenses` 确定性汇总。
- 查询意图优先于数字识别；问题中的日期或数量不能触发记账。写入与查询同时出现时，本轮只处理一次明确写入，查询须另发消息。
- 所有回复只展示最终结果，不展示思考过程、工具名、JSON、参数、候选分类或重试过程。

## 最小权限边界

写入始终走定制 `record_expense`，因为 ezBookkeeping 原生 MCP 的 `add_transaction` 不具备本项目的可信消息关联和消息 ID 去重。原生 MCP 只暴露 `query_transactions`：

- 服务级 `toolFilter.include` 和代理级 `tools.allow` 双重限制查询工具；
- requester-scoped resolver 只在当前消息来自 `openclaw-weixin`，且可信发送者命中 `commands.ownerAllowFrom` 时提供连接；
- 定时任务、心跳、子代理、其他发送者和缺少可信发送者元数据的运行都没有后备 MCP 连接；
- 有效工具目录必须包含 `query_transactions`，且不得包含 `add_transaction`。

HTTP API token 与原生 MCP token 是两份不同的本机秘密：前者供定制写入/汇总适配器使用，后者只由 requester-scoped MCP resolver 临时读入内存。未显式配置路径时，代码分别从 Node `homedir()`（Windows 通常为 `%USERPROFILE%`）下的 `.openclaw\secrets\ezbookkeeping-token.txt` 和 `.openclaw\secrets\ezbookkeeping-mcp-token.txt` 读取；两者不能混用，也不得进入仓库、OpenClaw 持久配置、提示词、日志或微信回复。

## 仓库布局

| 路径 | 用途 |
| --- | --- |
| `openclaw-plugins/clawbot-bookkeeping/` | 可信写入、确定性汇总、owner-only MCP resolver 及测试 |
| `openclaw-plugins/clawbot-bookkeeping/categories.mjs` | 运行时权威分类契约 `CATEGORY_DEFINITIONS` |
| `openclaw-plugins/openclaw-weixin-stable-id/` | 保留腾讯消息 ID 和发送者元数据的本地微信插件变体 |
| `openclaw-workspace/AGENTS.md` | 专用 Codex 记账代理的运行提示 |
| `config/expense-categories.json` | 脱敏的 11/45 分类导入与部署快照，不是运行时真源 |
| `config/*.example.json` | 不含真实身份和凭据的 OpenClaw 配置模板 |
| `scripts/install-ezbookkeeping-task.ps1` | 安装使用固定 Windows PowerShell 5.1 隐藏启动器的登录任务 |
| `scripts/configure-ezbookkeeping-mcp.ps1` | 备份配置、启用本机 MCP、交互生成并保护 MCP token |
| `WINDOWS-HANDOFF.md` | 详细部署、验证、恢复和交接说明 |

## 本机安装与验证

先安装与当前 OpenClaw 版本兼容的官方 Codex harness，并为专用代理完成 OpenAI 登录：

```powershell
openclaw plugins install codex --accept-capabilities
openclaw plugins enable codex --accept-capabilities
openclaw models auth login --provider openai --agent bookkeeper
```

`config/weixin-bookkeeper-agent.example.json` 将 `openai/gpt-5.6-sol` 显式绑定到 `agentRuntime.id: codex`，并把 Codex 动态工具加载设为 `direct`。专用代理只有五个经过 allowlist 的账本工具；直接加载让 Code Mode 可通过 `exec` 中现成的 `tools.<账本工具>` 调用，而不先搜索工具目录。包装返回字符串时必须原样输出完整字符串。这是 fail-closed 配置：Codex harness 不可用时该轮失败，不自动退回本地 Qwen 或其他模型。

账本插件还会把当前可信微信接收者的哈希身份绑定到工具回执，并把短期工具绑定、待确认项与权威回执交接保存到本地 SQLite。即使 Codex 内层工具轮次和微信外层发送轮次落在不同插件实例、使用不同运行编号，最后一跳也只会在接收者唯一匹配时预留并替换为工具生成的权威文本。发送成功后才消费回执，发送失败则释放预留；接收者不同或候选不唯一时拒绝猜测。原始微信身份不会写入日志或仓库。

两个安装脚本都支持 `-WhatIf`。先预演，再实际执行；MCP 配置脚本只在实际执行时交互读取密码。

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1

.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
.\scripts\configure-ezbookkeeping-mcp.ps1
```

默认配置文件使用实际嵌套布局 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。安装脚本创建精确任务动作：系统 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 以 `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden` 包装规范化后的 `ezbookkeeping.exe server run`；配置脚本在控制任务前核验同一启动器、完整参数和工作目录。配置脚本先创建唯一时间戳备份，再以原子替换方式更新 `[mcp]`，健康检查通过后才生成 MCP token。中途失败会尝试恢复配置和先前服务状态；若自动回滚也失败，按错误中给出的备份路径手工恢复后再重试。

从 Windows PowerShell 运行仓库检查：

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
openclaw plugins inspect codex
openclaw models status --agent bookkeeper --json
```

动态 MCP 由插件 manifest 和 requester-scoped resolver 声明，不应为了 CLI 诊断另加顶层 `mcp.servers` 静态连接。任何本机配置或部署变更前，必须执行 `WINDOWS-HANDOFF.md` 中只检查属性名的只读断言；若顶层 `mcp.servers` 下存在 `ezbookkeeping`，立即停止部署，另行审核后再移除，不能由部署步骤自动删除。该断言不显示配置对象、header 或值。它与账本插件自动化测试（manifest、resolver、allowlist 允许 `query_transactions`，源码和测试明确排除 `add_transaction`）及所有者微信历史查询共同闭合“无静态后备连接”的证据链；stable-ID 插件另有独立测试。

秘密扫描从仓库根目录执行时应排除嵌套 `.worktrees` 副本，但不得排除测试或示例目录；每一条命中都必须人工核对，任何无法证明是固定合成数据或占位符的结果都必须按真实泄露处理。详细命令见 `WINDOWS-HANDOFF.md`。

## 当前不做的事

本轮不部署 Vercel、不开放公网端口、不实现家庭网页登录。经用户明确授权，账本请求与必要查询结果会发送到当前 ChatGPT OAuth 下的 Codex 会话；本机 token、微信身份、消息 ID、SQLite 和 OpenClaw 状态仍不得上传。未来的家庭网页入口必须另行设计同步、登录、授权、备份和审计边界，不能直接暴露 Windows 本地账本。

详见 [WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md)。
