# 本地账本助理部署方案

更新时间：2026-09-03。当前发布是 Windows 本地实现；Mac 接收端已停止，Vercel 和家庭网页登录尚未进入本轮范围。

## 已定方案

```text
WeChat -> OpenClaw owner-bound local Qwen
  -> record_expense -> trusted write adapter -> ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
```

手机微信是输入与回复入口，腾讯 iLink 将消息交给 Windows OpenClaw。专用 `bookkeeper` 使用本地 Ollama `qwen3:8b` 理解账本意图；ezBookkeeping 1.6.1 在 `127.0.0.1:8180` 保存和查询本地 SQLite 数据。Gateway 也只绑定 loopback。

配置中的正式账户为唯一可见 SGD 账户 `日常支出`，微信回执显示账本名 `日常账本`。运行时以 `openclaw-plugins/clawbot-bookkeeping/categories.mjs` 中不可变的 `CATEGORY_DEFINITIONS` 为权威分类契约，固定为 11 个一级分类、45 个二级分类；`config/expense-categories.json` 只是脱敏的导入与部署目录快照。

## 为什么采用混合接入

写入继续使用定制 `record_expense`。它关联十分钟内的可信微信元数据，以 `channel + messageId` 持久去重，校验账户、金额、正式分类、备注与时间，再调用 HTTP API。原生 MCP 的 `add_transaction` 没有这层消息关联和去重；若模型在超时后重试，可能新增重复交易，因此绝不向代理开放。

读取分两条路径：

- `summarize_expenses` 通过 HTTP API 读取固定账户的支出，由代码按整数分计算今天、本周、本月、上月、今年或自定义范围内的总额、笔数、一级分类汇总和最大三笔。它可按正式分类或备注关键词过滤，不依赖模型心算。
- `ezbookkeeping__query_transactions` 使用 ezBookkeeping 原生 MCP 回答最近记录、商家或备注等灵活历史问题。第一版服务级与代理级都只允许 `query_transactions`，不开放余额、分类、标签、汇率和任何写工具。

查询优先识别。消息里出现日期、数量或“支出”不等于要写入；只有明确表达已发生消费且金额明确时才调用一次 `record_expense`。同一条消息同时要求写入和查询时，本轮只写一次，查询另发。

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

## 所有者限定的 MCP

`clawbot-bookkeeping` 注册 requester-scoped connection resolver。只有当前运行同时满足以下条件，才读取 MCP token 并在内存中构造连接：

1. 通道是 `openclaw-weixin`；
2. OpenClaw 提供非空可信 `requesterSenderId`；
3. `openclaw-weixin:<requesterSenderId>` 精确命中本机 `commands.ownerAllowFrom`。

其他发送者、定时任务、心跳、子代理、公开 Gateway 调用和缺少可信发送者信息的运行均返回 `null`，没有静态后备 MCP header。服务级 `toolFilter.include` 与代理 `tools.allow` 共同确保有效目录只包含 `query_transactions`，不包含 `add_transaction`。

API token 与 MCP token 必须分开：

- API token 文件默认位于当前用户的 `.openclaw\secrets\ezbookkeeping-token.txt`，供定制 HTTP 适配器读取；
- MCP token 文件默认位于 `.openclaw\secrets\ezbookkeeping-mcp-token.txt`，只供 owner-only resolver 读取；
- MCP token 文件关闭继承并只授予当前 Windows 用户访问；
- token 不得进入 Git、OpenClaw 持久配置、提示词、日志或微信回复。

即使 MCP token 不暴露给模型，本机其他进程若窃取它仍可能调用原生 MCP 服务。这是剩余风险，也是必须保持 loopback 与受限文件权限的原因。

## Windows 服务与配置

ezBookkeeping 默认目录为 `D:\Clawbot\ezbookkeeping`，配置文件使用真实嵌套路径 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。后台任务必须登录后自动启动、隐藏运行、异常重启、没有默认执行时限，并允许在电池状态下继续。

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

安装脚本创建 `Clawbot ezBookkeeping` 登录任务。MCP 配置脚本会：

1. 解析 `[mcp]` 并只把 `enable_mcp` 与 `mcp_allowed_remote_ips` 改为 `true` 和 `127.0.0.1`；
2. 原子创建不覆盖的时间戳备份，并原子替换配置；
3. 校验根目录中恰好一个同名任务，且可执行文件、参数 `server run` 和工作目录完全匹配；
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

openclaw mcp doctor ezbookkeeping --probe
openclaw mcp tools ezbookkeeping
openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
```

成功的 MCP 验证必须在有效 OpenClaw 工具目录中看到 `query_transactions`，且看不到 `add_transaction`。完整验收还包括：所有者发送一条新的消费得到六行回执并在 ezBookkeeping 中只出现一笔；随后分别询问本月汇总、分类汇总、最近三笔和备注关键词历史，并确认查询没有写入。

## 延后事项

本轮不部署 Vercel、不开放公网端口、不实现家庭网页登录，也不允许云端模型读取账本。家庭查看功能必须另行设计安全同步、认证、授权、备份和审计，不能直接把本地 ezBookkeeping 或 MCP 暴露到公网。
