<div align="center">

# WeChat Clawbot Ledger

**基于 OpenClaw 与 ezBookkeeping 的微信个人记账助手**

在微信里记录日常支出，获取可靠回执，随时查询自己的账本。

[![平台：Windows](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows-0078D4?style=flat-square)](#环境要求)
[![OpenClaw：2026.8.2](https://img.shields.io/badge/OpenClaw-2026.8.2-2563EB?style=flat-square)](https://github.com/openclaw/openclaw)
[![ezBookkeeping：1.6.1](https://img.shields.io/badge/ezBookkeeping-1.6.1-16A34A?style=flat-square)](https://github.com/mayswind/ezbookkeeping)
[![代码：TypeScript 与 JavaScript](https://img.shields.io/badge/%E4%BB%A3%E7%A0%81-TypeScript%20%2B%20JavaScript-3178C6?style=flat-square)](openclaw-plugins/)
[![运维：PowerShell](https://img.shields.io/badge/%E8%BF%90%E7%BB%B4-PowerShell-5391FE?style=flat-square)](scripts/)

[效果展示](#效果展示) · [功能特性](#功能特性) · [系统架构](#系统架构) · [本地开发](#本地开发) · [使用文档](#使用文档)

</div>

---

WeChat Clawbot Ledger 将微信中的自然语言对话连接到个人 ezBookkeeping 账本。OpenClaw 与官方 Codex harness 负责理解消息，本地记账插件负责校验、调用账本 API，并生成与实际结果一致的回复。

项目面向**单个所有者、一个 SGD 支出账户和持续运行的 Windows 主机**，包含插件源码、测试、配置模板与部署脚本。使用时需要配置自己的服务与凭据。

## 效果展示

<p align="center">
  <img src="docs/images/wechat-ledger-demo.jpg" alt="微信记账助手：支出回执、按备注汇总与日常查询" width="420" />
</p>

在同一段微信对话中完成记账、查看回执和查询支出，无需切换到独立记账应用。

## 功能特性

- **自然语言记账**：理解金额、分类、备注和明确的消费时间，默认使用 SGD 与 `Asia/Singapore` 时区。
- **有疑问先确认**：将不明确的支出保存为临时确认单，收到单独确认后才写入；取消则不记账。
- **以账本结果为准**：只有 API 确认写入后才回复成功，明确区分写入失败与提交结果不确定。
- **按消息去重**：关联可信发送者与上游消息 ID，同一条入站消息最多产生一笔支出；新消息中的相同文字仍视为独立事件。
- **精确支出汇总**：按时间范围计算总额、笔数、分类汇总和最大三笔，支持分类与备注关键词筛选。
- **按金额查账**：通过账本服务端过滤精确查找单笔 SGD 支出，默认查询全部历史，也可限定日期。
- **网页查看同一本账**：通过带健康检查的 Cloudflare Tunnel 访问 ezBookkeeping 原生网页界面。
- **后台无窗口启动**：账本与 Tunnel 任务在登录后使用非交互会话运行，详见[后台启动说明](docs/windows-background-startup.md)。
- **独立发布与回滚**：Windows 正式服务加载仓库外经过哈希校验的固定发布包，测试实例与正式账本分离。

### 对话示例

| 微信消息 | 助手行为 |
| --- | --- |
| `午饭花了7.20新币` | 记录一笔明确支出，返回完整回执。 |
| `午饭7.20吗` | 先生成确认单，确认后再写入。 |
| `今天花了多少钱` | 返回当天支出的精确汇总。 |
| `帮我查一下账本里有没有3.36的账` | 查找单笔金额恰好为 3.36 SGD 的支出。 |

金额查询默认显示最近 3 笔，最多显示 10 笔；存在更多匹配时会明确提示。接口失败或结果不可靠时，不会回答“没有记录”。

## 系统架构

```mermaid
flowchart LR
    W["微信 · 腾讯 iLink"] --> I["可信消息 ID 适配器"]
    I --> O["OpenClaw + 官方 Codex harness"]
    O --> B["clawbot-bookkeeping"]
    B -->|"校验后的写入与精确查询"| E["本地 ezBookkeeping"]
    B --- S["本地消息关联与确认状态"]
    U["浏览器"] --> T["带健康检查的 Cloudflare Tunnel"]
    T --> E
```

模型负责理解意图；插件负责执行账户、币种、分类、消息关联与写入规则。待确认项、可信消息关联和权威回执保存在本地 SQLite 中，以支持 Gateway 重启以及跨插件实例的工具调用；已结束的运行会撤销授权，确认消息哈希永久去重，避免旧确认操作新的候选。

Tunnel supervisor 在开放网页入口前，会核对正式进程、显式配置、健康响应和登录页指纹。任一条件失效时，只停止自己启动的 Tunnel 子进程，关闭公网访问路径。

### 服务边界

| 服务 | 地址与用途 |
| --- | --- |
| 正式 ezBookkeeping | `127.0.0.1:8888`，保存个人账本。 |
| 独立测试 ezBookkeeping | `127.0.0.1:18888`，使用独立配置、凭据和数据库。 |
| OpenClaw Gateway | `127.0.0.1:18789`，运行绑定所有者的专用记账助手。 |
| 网页访问 | 经 Cloudflare Tunnel 访问受保护的正式实例，使用 ezBookkeeping 原生登录。 |

### 工具与当前状态

| 工具 | 用途 | 状态 |
| --- | --- | --- |
| `record_expense` | 校验并记录一笔明确支出 | 已启用 |
| `prepare_expense` | 创建临时确认单 | 已启用 |
| `resolve_expense_confirmation` | 确认或取消当前确认单 | 已启用 |
| `summarize_expenses` | 计算精确支出汇总 | 已启用 |
| `find_expenses` | 按单笔 SGD 金额查账 | 已启用 |
| `ezbookkeeping__query_transactions` | 仅供所有者使用的原生 MCP 只读历史查询 | 已激活，真实微信查询通过 |

可选 MCP 集成需要独立启用本地服务并配置专用 token。记账、支出汇总和金额查询直接使用 HTTP API，不依赖 MCP；原生 MCP 的交易写入工具不在允许列表中。

## 项目状态

以下状态更新于 **2026-09-07**：

- 记账、确认、汇总和精确金额查询已启用。
- 金额查询已通过本地检查与真实微信验收，详见[发布记录](docs/handoffs/2026-09-06-amount-search-release.md)。
- 原生 MCP 历史查询已激活。代理使用 full 基础工具配置与六项精确 allowlist，保留只读查询能力。
- 跨插件实例的记账关联已修复并发布，完整回归 752/752、本机检查 14/14 通过；真实微信记账→历史查询→再记账、汇总、金额查询及确认流程均通过。测试记录已清理，账本恢复测试前基线，详见[系统检查记录](docs/handoffs/2026-09-07-bookkeeping-system-audit.md)。
- 平台使用同一个上游消息 ID 的真实重放验收仍未完成。自动化去重测试不能替代该项，因此整体部署验收仍有待完成的项目。

当前规则围绕单个所有者的 SGD 支出设计。人民币等其他币种、自由切换账户和更广泛的账本操作，需要同步调整校验与授权规则。

## 本地开发

### 环境要求

- Windows 与 PowerShell，用于部署和运维脚本。
- OpenClaw 2026.8.2 支持的 Node.js 版本：`>=22.22.3 <23`、`>=24.15.0 <25` 或 `>=25.9.0`。
- npm 与 Git。
- 联调服务：OpenClaw 2026.8.2、ezBookkeeping 1.6.1。

### 运行本地检查

克隆仓库，安装锁定版本的依赖，然后运行插件检查：

```powershell
git clone https://github.com/Awes0meE/WeChat-Clawbot-Ledger.git
Set-Location WeChat-Clawbot-Ledger

Push-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd ci
npm.cmd test
Pop-Location

Push-Location openclaw-plugins\openclaw-weixin-stable-id
npm.cmd ci
npm.cmd run build
node --test test\inbound-message-id.test.mjs
Pop-Location
```

仓库测试不得访问 `8888` 正式账本。真实账本联调必须使用 `18888` 独立测试实例及其专用凭据。

### 配置与部署

1. 阅读 [Windows 部署与恢复说明](WINDOWS-HANDOFF.md)和 [Ledger 运维手册](docs/ledger-cloudflare-runbook.md)。
2. 根据 [`config/`](config/) 中的模板配置自己的所有者绑定与服务，将真实凭据和运行状态保存在 Git 之外。
3. 按文档为专用记账助手完成官方 Codex harness 的交互式认证。
4. 在独立测试账本中验证功能。
5. 发布经过 manifest 校验的固定版本，依照运维手册完成服务、网页、重启、失败关闭和微信验收。

会修改状态的安装、迁移、发布和重启脚本支持 `-WhatIf`，执行前先预演。正式服务加载仓库外的已验证发布包，编辑工作区文件不会直接更新正在运行的服务。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`openclaw-plugins/clawbot-bookkeeping/`](openclaw-plugins/clawbot-bookkeeping/) | 可信写入、确认、汇总、金额查询、可选 MCP resolver 与测试 |
| [`openclaw-plugins/openclaw-weixin-stable-id/`](openclaw-plugins/openclaw-weixin-stable-id/) | 保留上游消息 ID 与发送者元数据的腾讯微信适配器 |
| [`openclaw-hooks/session-memory/`](openclaw-hooks/session-memory/) | 保护固定版本记账工作区的 hook |
| [`openclaw-workspace/`](openclaw-workspace/) | 专用记账助手的运行提示与行为约定 |
| [`config/`](config/) | 服务配置模板与分类定义 |
| [`scripts/`](scripts/) | Windows 安装、迁移、发布、Tunnel 监督与验收脚本 |
| [`docs/`](docs/) | 设计、实施计划、运维手册、验收记录与展示图片 |
| [`research/`](research/) | 记账集成方案的研究笔记 |

## 使用文档

- [Windows 部署与恢复](WINDOWS-HANDOFF.md)
- [Cloudflare Tunnel 部署与验收](docs/ledger-cloudflare-runbook.md)
- [精确金额查询发布记录](docs/handoffs/2026-09-06-amount-search-release.md)
- [微信回执关联修复与待验收项](docs/handoffs/2026-09-05-wechat-stale-reply-repair.md)
- [支出分类约定](docs/expense-categories.md)
- [项目开发规范](AGENTS.md)

## 隐私与安全

仓库保存可复现源码和服务配置模板。真实凭据、微信身份、账本数据库、备份和运行日志应保存在版本控制之外。测试使用合成数据，展示素材应获得授权，提交前检查暂存内容。

- 将记账助手限制到配置的所有者和账户。
- HTTP token 与 MCP token 分开保存在本机，不放入提示词或回执。
- 正式账本、测试账本和 Gateway 均仅监听 loopback。
- 保持注册与无效的密码找回功能关闭。
- 网页使用账本原生登录，不额外启用 Cloudflare Access。
- 写入结果不确定时，先核对账本再决定是否重新提交。

**本地保存账本不代表模型推理完全在本机进行。** 记账请求及回复所需的查询结果会经配置的 OpenAI Codex 会话处理，凭据不属于模型上下文。

## 参与贡献

请先阅读 [`AGENTS.md`](AGENTS.md)，保持改动集中，并使用 Conventional Commits 提交信息。行为变更需要补充回归测试，并运行相关检查。使用合成数据和独立测试账本，不在 Issue 或 PR 中附带凭据及未经授权的真实聊天、交易内容。

## 致谢与许可

本项目基于 [OpenClaw](https://github.com/openclaw/openclaw)、[ezBookkeeping](https://github.com/mayswind/ezbookkeeping) 与腾讯微信频道适配器构建。

仓库内的腾讯适配器保留其 [MIT 许可证与版权声明](openclaw-plugins/openclaw-weixin-stable-id/LICENSE)。**仓库整体尚未声明统一许可证**，该组件的 MIT 许可不自动覆盖所有项目文件。
