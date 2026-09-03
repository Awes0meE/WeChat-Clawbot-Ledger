# Clawbot

Clawbot 是一个私有、本地优先的微信个人账本助理。当前发布只运行在 Windows：

```text
WeChat -> OpenClaw owner-bound local Qwen
  -> record_expense -> trusted write adapter -> ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
```

仓库保存可复现源码、测试、文档和脱敏配置模板。真实凭据、微信身份、消息正文、OpenClaw 状态和账本数据只留在 Windows 主机。原 Mac 接收端已停止，不应与 Windows iLink 接收端同时运行。

## 当前基线

以下基线整理于 2026-09-03；接手时仍须重新探测实时状态。

| 组件 | 当前约束 |
| --- | --- |
| OpenClaw | 2026.8.2；Gateway 只绑定 `127.0.0.1:18789` |
| 微信入口 | 腾讯 iLink；只路由已绑定的所有者账号到专用 `bookkeeper` |
| 本地模型 | Ollama `qwen3:8b`；8192-token context；thinking off |
| 账本 | ezBookkeeping 1.6.1；只绑定 `127.0.0.1:8180` |
| 账户与币种 | 唯一可见 SGD 账户 `日常支出`；回执显示 `日常账本` |
| 分类 | `config/expense-categories.json` 中固定的 11 个一级、45 个二级分类 |
| 专用代理 allowlist | `record_expense`、`summarize_expenses`、`ezbookkeeping__query_transactions` |

## 助理行为

### 写入支出

本地模型理解金额、正式分类和语义备注；程序负责可信微信消息关联、字段校验、写入和去重。一条入站消息最多新增一笔支出，去重键为可信 `channel + messageId`，而不是消息正文。

- 默认 SGD、`Asia/Singapore`。
- 微信时间戳被规范为 Unix 秒后提交给 ezBookkeeping；毫秒输入会先除以 1000。
- 显式“备注”后的原文优先；否则模型只可提炼消息中明确出现的商家、商品或用途，不得补充事实。
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
- `ezbookkeeping__query_transactions` 处理“最近三笔是什么”“上月在某商家买过什么”等灵活历史查询。默认最多读取 3 条，单次最多 10 条。
- 查询意图优先于数字识别；问题中的日期或数量不能触发记账。写入与查询同时出现时，本轮只处理一次明确写入，查询须另发消息。
- 所有回复只展示最终结果，不展示思考过程、工具名、JSON、参数、候选分类或重试过程。

## 最小权限边界

写入始终走定制 `record_expense`，因为 ezBookkeeping 原生 MCP 的 `add_transaction` 不具备本项目的可信消息关联和消息 ID 去重。原生 MCP 只暴露 `query_transactions`：

- 服务级 `toolFilter.include` 和代理级 `tools.allow` 双重限制查询工具；
- requester-scoped resolver 只在当前消息来自 `openclaw-weixin`，且可信发送者命中 `commands.ownerAllowFrom` 时提供连接；
- 定时任务、心跳、子代理、其他发送者和缺少可信发送者元数据的运行都没有后备 MCP 连接；
- 有效工具目录必须包含 `query_transactions`，且不得包含 `add_transaction`。

HTTP API token 与原生 MCP token 是两份不同的本机秘密：前者供定制写入/汇总适配器使用，后者只由 requester-scoped MCP resolver 临时读入内存。二者都不得进入仓库、OpenClaw 持久配置、提示词、日志或微信回复。

## 仓库布局

| 路径 | 用途 |
| --- | --- |
| `openclaw-plugins/clawbot-bookkeeping/` | 可信写入、确定性汇总、owner-only MCP resolver 及测试 |
| `openclaw-plugins/openclaw-weixin-stable-id/` | 保留腾讯消息 ID 和发送者元数据的本地微信插件变体 |
| `openclaw-workspace/AGENTS.md` | 专用本地记账代理的运行提示 |
| `config/expense-categories.json` | 固定 11/45 分类源 |
| `config/*.example.json` | 不含真实身份和凭据的 OpenClaw 配置模板 |
| `scripts/install-ezbookkeeping-task.ps1` | 安装可恢复的 Windows 登录自启动任务 |
| `scripts/configure-ezbookkeeping-mcp.ps1` | 备份配置、启用本机 MCP、交互生成并保护 MCP token |
| `WINDOWS-HANDOFF.md` | 详细部署、验证、恢复和交接说明 |

## 本机安装与验证

两个安装脚本都支持 `-WhatIf`。先预演，再实际执行；MCP 配置脚本只在实际执行时交互读取密码。

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1

.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
.\scripts\configure-ezbookkeeping-mcp.ps1
```

默认配置文件使用实际嵌套布局 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。配置脚本先创建唯一时间戳备份，再以原子替换方式更新 `[mcp]`，校验并重启唯一的预期计划任务，健康检查通过后才生成 MCP token。中途失败会尝试恢复配置和先前服务状态；若自动回滚也失败，按错误中给出的备份路径手工恢复后再重试。

从 Windows PowerShell 运行仓库检查：

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

MCP probe 与工具目录必须只显示允许的 `query_transactions`，不得出现 `add_transaction`。端到端验收还须由所有者发送一条新的真实消费并核对六行回执与账本记录，再分别验证汇总和历史查询。

## 当前不做的事

本轮不部署 Vercel、不开放公网端口、不实现家庭网页登录，也不把账本内容交给云端模型。未来的家庭网页入口必须另行设计同步、登录、授权、备份和审计边界，不能直接暴露 Windows 本地账本。

详见 [WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md)。
