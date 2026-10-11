<div align="center">

# WeChat Clawbot Ledger

**基于 OpenClaw 与 ezBookkeeping 的微信个人记账助手**

在微信里记录日常支出，获取可靠回执，随时查询自己的账本。

[![平台：Windows 与 Mac](https://img.shields.io/badge/platform-Windows%20%7C%20Mac-0078D4?style=flat-square)](#选择部署系统)
[![OpenClaw：2026.8.2](https://img.shields.io/badge/OpenClaw-2026.8.2-2563EB?style=flat-square)](https://github.com/openclaw/openclaw)
[![ezBookkeeping：1.6.1](https://img.shields.io/badge/ezBookkeeping-1.6.1-16A34A?style=flat-square)](https://github.com/mayswind/ezbookkeeping)
[![代码：TypeScript 与 JavaScript](https://img.shields.io/badge/%E4%BB%A3%E7%A0%81-TypeScript%20%2B%20JavaScript-3178C6?style=flat-square)](openclaw-plugins/)
[![运维：PowerShell](https://img.shields.io/badge/%E8%BF%90%E7%BB%B4-PowerShell-5391FE?style=flat-square)](scripts/)

[效果展示](#效果展示) · [功能特性](#功能特性) · [系统架构](#系统架构) · [本地开发](#本地开发) · [使用文档](#使用文档)

</div>

---

WeChat Clawbot Ledger 将微信中的自然语言对话连接到个人 ezBookkeeping 账本。OpenClaw 与官方 Codex harness 负责理解消息，本地记账插件负责校验、调用账本 API，并生成与实际结果一致的回复。

项目面向**单个所有者、经过核验的多币种子账户和持续运行的本地主机**，保留 Windows 原生部署与 Mac Apple Silicon Docker 两条路线。仓库包含插件源码、测试、配置模板与运维脚本；使用时需要配置自己的服务与凭据。

## 选择部署系统

| 你的电脑 | 配置入口 | 已验证范围 |
| --- | --- | --- |
| Windows | [Windows 安装与恢复](WINDOWS-HANDOFF.md#windows-安装) · [公网账本运维](docs/ledger-cloudflare-runbook.md) | 原生 OpenClaw、ezBookkeeping、计划任务及原生 MCP；部署接口继续维护 |
| Mac（Apple Silicon） | [Docker 隔离环境配置](deploy/docker/README.md) · [迁移与运维清单](docs/mac-before-windows-checklist.md) | ARM64 Docker 原型，以及既有 Windows 账本迁入后的正式微信、网页和备份恢复 |

Mac 的全新生产安装向导尚未验收，测试初始化不会自动启用正式微信；Intel Mac 和 Windows Docker 也未验证。现有 Windows 用户迁移时使用 [九卷迁移合同](docs/mac-migration-intake.md)，必须先停止旧端，不能同时运行两个生产接收器。

## 效果展示

<p align="center">
  <img src="docs/images/wechat-ledger-demo.jpg" alt="微信记账助手：支出回执、按备注汇总与日常查询" width="420" />
</p>

在同一段微信对话中完成记账、查看回执和查询支出，无需切换到独立记账应用。

## 功能特性

- **自然语言记账**：理解金额、分类、备注和明确的消费时间，默认使用 SGD 与 `Asia/Singapore` 时区。
- **用餐描述按发送时间记账**：“中午吃饭”“晚上吃饭”和“午饭”“晚饭”一样，没有另外写日期或具体钟点时，直接使用消息发送时间。
- **图片语义记账**：AI 判断单笔已发生支出的金额、消费日期、用途；三项齐全即可入账，不要求固定标签。缺日期先询问；无币种信息默认 SGD 并说明，明确原币保留，冲突先澄清。重复图片防重，明确删账后可按新消息重记。
- **四则运算**：精确计算加、减、乘、除；数字间斜杠如 `3.8/2` 先拟单 1.90，确认后写入，显式 `3.8÷2` 可直接记录；不舍入非整分结果。
- **有疑问先确认**：将不明确的支出保存为临时确认单，收到“是的、好的、没问题、行、记入、确认、对的”等单独确认后才写入；“取消、不记、不要、撤销、忽略、拉倒”等会取消待确认项。带问号或修改内容的消息不按确认词前缀入账，取消不删除历史交易。
- **金额模糊先拟单**：多个可疑数字由现有 AI 判断最可能的实付金额，再返回完整确认单；型号 F1、衣物件数不会使明确价格被误拒绝。
- **原币记账**：支持 ezBookkeeping 1.6.1 全部 159 个 ISO 币种代码及明确名称，按原币存入对应子账户；未声明时默认 SGD，旧 SGD 历史保留。
- **一条回复回答多个问题**：同时给出支出汇总、人民币等目标币种换算，或组合多个只读问题。
- **每日中行汇率**：使用中国银行现汇卖出价，每天 00:00 新加坡时间更新缓存，缺价时明确说明；不改动 ezBookkeeping 网页内置汇率来源。
- **以账本结果为准**：只有 API 确认写入后才回复成功，明确区分写入失败与提交结果不确定。
- **按消息去重**：关联可信发送者与上游消息 ID，同一条入站消息最多产生一笔支出；新消息中的相同文字仍视为独立事件。
- **精确支出汇总**：按时间范围计算总额、笔数、分类汇总和最大三笔，支持分类与备注关键词筛选。
- **按金额查账**：通过账本服务端过滤精确查找单笔原币支出，默认查询全部历史，也可限定日期。
- **清晰展示历史明细**：校验 MCP 查询结果，按编号展示时间、原币金额、分类和备注；专用代理只查询已核验的旧账户与多币种子账户，每次最多十笔，不发送原始 JSON。
- **网页查看同一本账**：通过带健康检查的 Cloudflare Tunnel 访问 ezBookkeeping 原生网页界面。
- **常驻与状态页**：Windows 使用[后台任务](docs/windows-background-startup.md)，Mac 使用登录服务及[简洁生产看板](docs/mac-production-dashboard.md)，在本机查看账本、微信和公网状态。
- **Mac 运行记录**：约每 15 秒采样，保存错误阶段、超时和故障前最多约 30 分钟的状态；约 38 MiB 自动轮转，不记录聊天、账目和令牌。
- **固定发布与备份恢复**：正式服务加载仓库外的已验证发布。Mac 提供九卷加密备份、独立恢复及保留旧卷的版本更新，测试和生产数据分离。

### 对话示例

| 微信消息 | 助手行为 |
| --- | --- |
| `午饭花了7.20新币` | 记录一笔明确支出，返回完整回执。 |
| `午饭7.20吗` | 先生成确认单，确认后再写入。 |
| `午饭6点6 食阁` | 按口述小数记录 6.60 SGD。 |
| `午饭35人民币` | 原币记录 35 CNY。 |
| `今天花了多少钱，换成人民币呢` | 一次回复支出汇总和人民币折合金额。 |
| `最近三次支出是什么` | 返回三笔整理好的支出明细。 |
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

回复同时绑定最新真实消息：新请求会使旧的失败回复失效，迟到的旧确认单也不能在新话题之后重新生效。重复投递不会推进这项状态。正式切换前还会验证 full 与精确六工具配置，避免历史工具被基础配置过滤。

Tunnel supervisor 在开放网页入口前，会核对正式进程、显式配置、健康响应和登录页指纹。任一条件失效时，只停止自己启动的 Tunnel 子进程，关闭公网访问路径。

### 服务边界

| 服务 | 地址与用途 |
| --- | --- |
| 正式 ezBookkeeping | `127.0.0.1:8888`，保存个人账本。 |
| 独立测试 ezBookkeeping | `127.0.0.1:18888`，使用独立配置、凭据和数据库。 |
| OpenClaw Gateway | `127.0.0.1:18789`，运行绑定所有者的专用记账助手。 |
| 网页访问 | 经 Cloudflare Tunnel 访问受保护的正式实例，使用 ezBookkeeping 原生登录。 |

Mac Docker 的正式账本和 Gateway 回环地址位于共享容器网络空间，未映射为 Mac 宿主端口；本机看板单独使用 `127.0.0.1:18990`。

### 工具与当前状态

| 工具 | 用途 | 状态 |
| --- | --- | --- |
| `record_expense` | 校验并记录一笔明确支出 | 已启用 |
| `prepare_expense` | 创建临时确认单 | 已启用 |
| `resolve_expense_confirmation` | 确认或取消当前确认单 | 已启用 |
| `summarize_expenses` | 计算精确支出汇总 | 已启用 |
| `find_expenses` | 按单笔原币金额查账 | 已启用 |
| `ezbookkeeping__query_transactions` | 仅供所有者使用的 MCP 只读历史查询 | 已通过真实微信验收 |

MCP 集成需要独立启用本地服务并配置专用 token。Windows 保留原生 MCP，Mac 使用固定官方 MCP SDK 的受限适配，官方 Codex harness 不变。记账、支出汇总和金额查询直接使用 HTTP API，不依赖 MCP；原生 MCP 的交易写入工具不在允许列表中。

## 项目状态

以下状态更新于 **2026-10-11**，描述参考部署，源码同步不会自动部署到其他用户的机器：

- Mac runtime、guard、宿主与看板已发布图片语义校验版本 `0f4114f`，保留四则运算、多币种、每日汇率、图片防重和存储观测修复；详见 [本次发布](docs/handoffs/2026-10-11-image-semantic.md)。没有更换官方模型、harness 或扩大六工具权限。
- [100 组图片验证](test-cases/results/2026-10-11-image-semantic.md)包含 2 张私有故障原图、10 张公开原图与 88 组合成场景；最终规则为 56 组入账、44 组合理追问/拒绝，通过基线加定向复验完成，额外 21 个步骤通过。不是最后镜像完整重跑 100 组，也不是随机抽样准确率。原图和原始模型日志不随仓库分发。
- 便携检查 1098 通过、1 项既有跳过；固定 ARM64 图片/回执/配置迁移 208/208。[文字用例库](test-cases/README.md)共 238 条，历史实际模型报告保留。Windows 原生新功能与手机新图片回执未重新验收。
- 当前九卷备份、独立恢复、新卷比对、原数据保留及上线检查通过。用户明确授权的两笔失败原图已通过正式 API 补录、核对和防重关联；补录后新备份恢复验证通过。具体交易数据、凭据、运行身份和私有 Git 历史没有导出。
- 2026-10-03 已修复明确的临时存储测量失败直接永久锁停的问题，真实磁盘错误及既有故障锁仍保护；底层 Docker 偶发卡顿原因未确定。当前 [运行诊断](docs/mac-runtime-diagnostics.md)持续保存有界状态与失败阶段。
- 历史手机记账、查询与确认流程有单独验收记录；无人登录启动、家庭路由器断网补收和腾讯同消息 ID 重放仍未实测。Windows 异机恢复属于历史版本，不能冒称本轮新备份已异机验收。

当前运维入口见 [Mac 清单](docs/mac-before-windows-checklist.md)、[Windows 安装](WINDOWS-HANDOFF.md)与[备份恢复](docs/mac-maintenance-backup.md)。

## 本地开发

### 环境要求

- Windows 与 PowerShell，或 Apple Silicon Mac 与 Docker Desktop；按对应路线配置。
- OpenClaw 2026.8.2 支持的 Node.js 版本：`>=22.22.3 <23`、`>=24.15.0 <25` 或 `>=25.9.0`。
- npm 与 Git。
- 联调服务：OpenClaw 2026.8.2、ezBookkeeping 1.6.1。

### Windows 本地检查

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

### Mac 本地检查

```sh
git clone https://github.com/Awes0meE/WeChat-Clawbot-Ledger.git
cd WeChat-Clawbot-Ledger
npm --prefix openclaw-plugins/clawbot-bookkeeping ci
npm --prefix openclaw-plugins/openclaw-weixin-stable-id ci
node scripts/run-portable-tests.mjs
npm --prefix openclaw-plugins/openclaw-weixin-stable-id run build
node --test openclaw-plugins/openclaw-weixin-stable-id/test/*.test.mjs
```

Docker 构建、独立账本初始化和本机模型登录按 [Mac Docker 配置](deploy/docker/README.md) 顺序执行。该环境不导入生产账目，也不启动真实微信接收器。

仓库测试不得访问 `8888` 正式账本。真实账本联调必须使用 `18888` 独立测试实例及其专用凭据。

### 配置与部署

1. 按上面的系统表选择 Windows 或 Mac 入口；现有服务先核验实际身份与备份，新环境先建立独立测试实例。
2. 根据 [`config/`](config/) 中的模板配置自己的所有者绑定与服务，将真实凭据和运行状态保存在 Git 之外。
3. 按文档为专用记账助手完成官方 Codex harness 的交互式认证。
4. 在独立测试账本中验证功能。
5. 发布经过 manifest 校验的固定版本，依照运维手册完成服务、网页、重启、失败关闭和微信验收。

Windows 安装和运维脚本按文档使用 `-WhatIf` 预演；Mac 生产入口使用独立的准备、审核与执行阶段，不能套用 PowerShell 参数。正式服务加载仓库外的已验证发布包，编辑工作区文件不会直接更新正在运行的服务。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`openclaw-plugins/clawbot-bookkeeping/`](openclaw-plugins/clawbot-bookkeeping/) | 可信写入、确认、汇总、金额查询、可选 MCP resolver 与测试 |
| [`openclaw-plugins/openclaw-weixin-stable-id/`](openclaw-plugins/openclaw-weixin-stable-id/) | 保留上游消息 ID 与发送者元数据的腾讯微信适配器 |
| [`openclaw-hooks/session-memory/`](openclaw-hooks/session-memory/) | 保护固定版本记账工作区的 hook |
| [`openclaw-workspace/`](openclaw-workspace/) | 专用记账助手的运行提示与行为约定 |
| [`config/`](config/) | 服务配置模板与分类定义 |
| [`scripts/`](scripts/) | Windows 与 Mac 安装／迁移、发布、备份、守护与验收脚本 |
| [`docs/`](docs/) | 设计、实施计划、运维手册、验收记录与展示图片 |
| [`research/`](research/) | 记账集成方案的研究笔记 |

## 使用文档

- [Windows 部署与恢复](WINDOWS-HANDOFF.md)
- [Mac Docker 配置](deploy/docker/README.md)与[运维清单](docs/mac-before-windows-checklist.md)
- [Mac 备份与恢复](docs/mac-maintenance-backup.md)
- [运行诊断与排查](docs/mac-runtime-diagnostics.md)
- [专用插电服务器合盖息屏](docs/mac-lid-display-sleep.md)
- [模型、微信和账本授权恢复](docs/mac-authorization-recovery.md)
- [Cloudflare Tunnel 部署与验收](docs/ledger-cloudflare-runbook.md)
- [多币种、合并查询和每日中行汇率](docs/multicurrency-and-rates.md)
- [微信消息用例与实测结果](test-cases/README.md)
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
