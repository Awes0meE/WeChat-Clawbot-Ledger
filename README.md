# Clawbot

Clawbot 是一个私有、Windows 托管的微信个人账本助理。当前发布只运行在 Windows：

```text
WeChat -> OpenClaw immutable release -> owner-bound OpenAI GPT-5.6 Sol (official Codex harness)
  -> record_expense | prepare_expense | resolve_expense_confirmation
     -> trusted write/confirmation adapter -> 127.0.0.1:8888 ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
     (code-ready; local MCP activation still pending)

Browser -> https://ledger.66ccff-labs.com -> Cloudflare Tunnel
  -> guarded 127.0.0.1:8888 -> the same ezBookkeeping and SQLite
```

仓库保存可复现源码、测试、文档和脱敏配置模板。真实凭据、微信身份、消息正文、OpenClaw 状态和账本数据只留在 Windows 主机。原 Mac 接收端已停止，不应与 Windows iLink 接收端同时运行。

## 当前基线

以下运行合同更新于 2026-09-05；实时上线状态必须以 `docs/ledger-cloudflare-runbook.md` 的完整验收为准，不能仅凭配置或文档推断。

| 组件 | 当前约束 |
| --- | --- |
| OpenClaw | 2026.8.2；Gateway 只绑定 `127.0.0.1:18789` |
| 微信入口 | 腾讯 iLink；只路由已绑定的所有者账号到专用 `bookkeeper` |
| 助理模型 | OpenAI `gpt-5.6-sol`；官方 `@openclaw/codex` 2026.8.2 harness；ChatGPT OAuth；thinking low |
| 正式账本 | ezBookkeeping 1.6.1；只绑定 `127.0.0.1:8888`；注册与无效找回密码关闭 |
| 测试账本 | 独立 `127.0.0.1:18888`、独立配置/token/SQLite；UUID server ID 为 `1`（正式为 `0`）；自动化不得回退到正式端口 |
| 网页入口 | `ledger.66ccff-labs.com` 只经健康门控 Cloudflare Tunnel；无 Cloudflare Access；apex/`www` 作品集路由不变 |
| 生产代码 | OpenClaw 只加载仓库外、manifest 校验过的 immutable release，不直接加载开发工作区 |
| 账户与币种 | 唯一可见 SGD 账户 `日常支出`；回执显示 `日常账本` |
| 分类 | 运行时以 `openclaw-plugins/clawbot-bookkeeping/categories.mjs` 的不可变 `CATEGORY_DEFINITIONS` 为权威契约，固定为 11 个一级、45 个二级分类 |
| 专用代理 allowlist | `record_expense`、`prepare_expense`、`resolve_expense_confirmation`、`summarize_expenses`、`ezbookkeeping__query_transactions` |
| 灵活历史查询 | 代码与最小权限契约已就绪；截至 2026-09-04，本机 `enable_mcp=false` 且独立 MCP token 尚未生成，因此尚未上线 |

## 助理行为

### 写入支出

Codex 先在内部理解消费时间、金额、币种、正式分类和语义备注；程序负责可信微信消息关联、字段校验、写入和去重。一条入站消息最多新增一笔支出，去重键为可信 `channel + messageId`，而不是消息正文。

- 默认 SGD、`Asia/Singapore`。
- 插件只在当前 owner 消息已与可信微信入站记录关联、且本轮获准使用记账工具时，把发送时间注入 Codex 上下文，供“昨天”等相对日期换算；不注入账号、消息 ID 或 token。
- 用户明确写了消费日期或具体钟点时，Codex 通过结构化字段提交解析结果和原文时间证据，插件验证后将该消费时间写入 ezBookkeeping。没有时间表达才使用可信微信发送时间；只给日期没给具体钟点时保留发送时分。
- 最终时间规范为 Unix 秒；毫秒输入会先除以 1000。明显晚于发送时间超过 5 分钟的时间会在写入前被拒绝。
- 没有币种标记的本地金额按 SGD 处理；明确的非 SGD 金额不会自动换汇或入账，助理会先询问对应的 SGD 金额。
- 显式“备注”后的原文优先；否则模型只可提炼消息中明确出现的商家、商品或用途，不得补充事实。
- Codex 判断是否为本人已发生支出；插件不再用商户白名单或大量中文句式取代模型。插件仍硬性要求当前可信消息中只有一个相关金额、金额与工具参数一致，并拦截明显疑问的直接写入。
- `午饭7.2吗` 这类信息先由 `prepare_expense` 保存十分钟待确认提案并返回完整表单，绝不访问账本。用户单独回复“是”才由 `resolve_expense_confirmation` 使用原消息的金额、分类、备注和已解析消费时间入账；回复“不是”则取消。
- 每个所有者会话最多一张待确认单。新的实质消息会替换旧上下文并使旧确认单失效；重复确认不会产生第二笔。状态保存在本地 SQLite，Gateway 重启或上下文压缩不会丢失。
- 写入成功后返回固定六行回执；例如：

```text
记下来啦！🧾
- 账本：[ 日常账本 ]
- 支出：7.20 SGD
- 分类：食品酒水 - 早午晚餐
- 备注：无
- 时间：2026/09/03 16:21
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
| `config/ezbookkeeping-*.example.ini` | 正式/测试实例的脱敏安全配置合同 |
| `config/cloudflared-ledger.example.yml` | 只有精确 Ledger ingress 与 404 catch-all 的 Tunnel 示例 |
| `config/cloudflare-ledger-rules.example.json` | 精确 hostname 的 redirect/cache/header/WAF/rate-limit 清单 |
| `scripts/migrate-ledger-production.ps1` | 备份并验证后把已识别正式实例从旧端口迁移到 `8888` |
| `scripts/install-ledger-test-instance.ps1` | 安装 `18888` 独立测试实例，不复制正式数据 |
| `scripts/publish-openclaw-release.ps1` | 发布、校验并可回滚切换 immutable OpenClaw release |
| `scripts/install-ledger-tunnel-task.ps1` | 安装并可在完整身份复核后首次启动 health-gated、fail-closed Tunnel supervisor task |
| `scripts/test-ledger-local.ps1` | 脱敏本机配置、端口、release 与 Tunnel 验收 |
| `scripts/test-ledger-public.ps1` | 公网安全、token 边界与作品集回归验收 |
| `scripts/test-ledger-restart.ps1` | 精确任务重启、错误 owner 与 fail-closed 恢复验收 |
| `scripts/configure-ezbookkeeping-mcp.ps1` | 备份配置、启用本机 MCP、交互生成并保护 MCP token |
| `docs/ledger-cloudflare-runbook.md` | 完整部署、Cloudflare 规则、验收和 rollback 手册 |
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

所有会修改正式状态的安装、迁移、发布和重启脚本都支持 `-WhatIf`。先预演，再实际执行；交互密码只在 visible terminal 中读取，不进入命令行、聊天或日志。

```powershell
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
$releaseRoot = 'D:\Clawbot\releases'
$releaseBackupRoot = "$env:USERPROFILE\.openclaw\backups"
$openClawConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json"
$existingReleasePath = 'D:\Clawbot\releases\<COMMIT_SHA_FROM_RELEASE_ONLY>'
$tunnelConfigPath = 'D:\Clawbot\cloudflared\ledger.yml'
$credentialPath = 'D:\Clawbot\cloudflared\<LOCAL_TUNNEL_UUID>.json'
$approvedCloudflaredSha256 = '<64_HEX_FROM_SEPARATELY_VERIFIED_OFFICIAL_RELEASE_CHECKSUM>'
$actualCloudflaredSha256 = (Get-FileHash -LiteralPath 'D:\Clawbot\cloudflared\cloudflared.exe' -Algorithm SHA256).Hash
if ($actualCloudflaredSha256 -cne $approvedCloudflaredSha256) { throw 'cloudflared checksum mismatch' }

.\scripts\install-ledger-test-instance.ps1 -WhatIf
.\scripts\migrate-ledger-production.ps1 -WhatIf
.\scripts\publish-openclaw-release.ps1 `
  -SourceRoot $sourceRoot `
  -ReleaseRoot $releaseRoot `
  -BackupRoot $releaseBackupRoot `
  -OpenClawConfigPath $openClawConfigPath `
  -ReleaseOnly `
  -WhatIf
.\scripts\publish-openclaw-release.ps1 `
  -SourceRoot $sourceRoot `
  -ReleaseRoot $releaseRoot `
  -BackupRoot $releaseBackupRoot `
  -OpenClawConfigPath $openClawConfigPath `
  -SwitchOpenClaw `
  -ExistingReleasePath $existingReleasePath `
  -WhatIf
.\scripts\install-ledger-tunnel-task.ps1 `
  -CredentialPath $credentialPath `
  -TunnelConfigPath $tunnelConfigPath `
  -ExpectedCloudflaredSha256 $approvedCloudflaredSha256 `
  -StartAfterInstall `
  -WhatIf

# 只在 release 已切换且 Tunnel task 已安装/启动后运行完整本机验收
.\scripts\test-ledger-local.ps1 `
  -ReleasePath $existingReleasePath `
  -CredentialPath $credentialPath `
  -TunnelConfigPath $tunnelConfigPath `
  -ExpectedCloudflaredSha256 $approvedCloudflaredSha256

.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
.\scripts\configure-ezbookkeeping-mcp.ps1
```

正式配置使用 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`，计划任务动作必须显式带该 `--conf-path`。迁移前脚本验证环境变量优先级、任务动作、PID/创建时间/程序路径/命令行、端口 owner、health 和唯一启用用户，再在仓库外创建配置、任务定义与 WAL-safe SQLite 备份。它不停止未知进程、不删除账户，也不自动恢复数据库。

生产 release 默认位于 `D:\Clawbot\releases`；正式 plugin/workspace 路径不得落入 Git checkout。Tunnel 的真实配置和 JSON 只放在受限本机目录，任务只运行 supervisor。Supervisor 连续验证 `8888` owner、显式 production config、health 与 ezBookkeeping 页面指纹后才启动自己的 cloudflared child；任一条件退化即只停止该 child，公网失败关闭。

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

## 明确不做的事

账本不部署到 Vercel，不把 SQLite 或交易同步到 GitHub，也不开放家庭网络端口。网页直接复用 ezBookkeeping UI 和一次应用登录；不启用 Cloudflare Access，不开发第二套前端。`66ccff-labs.com` 与 `www.66ccff-labs.com` 继续进入现有作品集，不属于 Ledger 部署修改范围。

经用户明确授权，账本请求与必要查询结果会发送到当前 ChatGPT OAuth 下的 Codex 会话；本机 token、Cloudflare 身份、微信身份、消息 ID、SQLite、交易内容、日志和 OpenClaw 状态仍不得上传或提交。

上线与维护必须完整遵循 [Ledger Cloudflare Tunnel 运维手册](docs/ledger-cloudflare-runbook.md) 和 [WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md)。
