# Windows 运行与交接：微信 OpenClaw 个人记账系统

整理并更新于 2026-09-03，Asia/Singapore。此文件同时记录 Mac 历史基线、Windows 当前实测状态和后续开发边界；运行状态仍应在接手时重新探测。

## 当前运行基线

请先阅读本文件和 `config/expense-categories.json`，再检查 Windows 上“微信官方 iLink → OpenClaw → 本地小模型 → ezBookkeeping”的实时状态。优先维护现有链路；只在实际发现缺口时增加少量适配代码，不要重新做候选项目调研。

用户已经确认使用 Windows 本地链路。Windows 微信接收端已启用，Mac 接收端已停止；不要让两个 iLink 接收端同时运行。扫码或缺少必要访问资料时向用户说明具体一步即可，不要反复要求批准已经同意的正常安装配置工作。

Windows 的模型、账本、分类、专用记账插件、微信渠道与常驻服务均已部署。2026-09-03 用户发送真实消费消息后，手机收到“已记账”回复；该成功回执只会在 ezBookkeeping 写入确认后生成。

## Windows 当前实测进度

| 项目 | 2026-09-03 实测状态 |
| --- | --- |
| 系统 / 硬件 | Windows 11 build 22631；Ryzen 9 6900HX；RTX 3070 Ti Laptop 8GB；32GB RAM |
| OpenClaw | 2026.8.2；Scheduled Task 常驻；`127.0.0.1:18789`；探测通过 |
| 本地模型 | Ollama 0.33.2；`qwen3:8b` Q4；全 GPU；8192 context；thinking off |
| 模型工具调用 | Qwen 直接调用 `bookkeeping_health` 与 `record_expense`；真实微信记账已返回成功 |
| ezBookkeeping | v1.6.1；`D:\Clawbot\ezbookkeeping`；`127.0.0.1:8180`；登录自启动任务运行中且端口复查通过 |
| 测试账本 | 测试账户已注册；可见 SGD 账户“日常支出”1 个；11/45 分类已导入并核验 |
| 记账适配 | `openclaw-plugins/clawbot-bookkeeping`；固定 loopback API；跨插件实例的短时可信元数据；持久 SQLite 消息去重；13 项测试通过 |
| 微信插件 | 腾讯 2.4.8 的本地稳定消息 ID / sender 元数据变体；已启用、已配置、运行中 |
| 常驻条件 | 插电睡眠/休眠均为“从不”；Ollama 在用户启动项；Gateway 与账本有各自登录自启动 |

敏感凭据与真实微信账号标识只留在各程序的本地状态或被 Git 忽略的本机配置中。仓库只保留去标识化示例；Mac 接收端保持停止。

## 最终目标和分工

当前要做的是个人微信记账，支持单条消费记录及按需查询。未来才考虑 Windows 文件与 Git 状态检查、Codex 编程、Mac 本地大模型、预算复盘和定时任务。

```text
手机微信里的 ClawBot
       ↕
腾讯官方 iLink
       ↕
Windows 上常驻的 OpenClaw Gateway
       ├─ 本地小型 Qwen：理解每条消费并选择分类
       └─ 账本工具 → ezBookkeeping → Windows 本地 SQLite

Mac：后续管理端 / 按需执行设备，本阶段不承担必需的在线服务
```

OpenClaw 负责消息、会话、模型调用和工具执行，本身不是提供推理能力的模型。手机微信是输入与回复入口；模型理解消费，账本程序保存和查询数据。当前 Mac 使用 OpenAI 云端模型，计划中的 Windows 记账改用本地小模型。即使推理本地化，消息仍会经过微信和腾讯 iLink。

把 Gateway 放 Windows 的原因：Mac 经常合盖放包，睡眠或离线期间无法保证回复；Windows 长期插电联网，更适合常驻。显示器可以关闭，关键是主机不进入阻断服务的睡眠，并验证重启后的服务恢复。

## 设备和不能动的环境

| 设备 | 已知信息 |
| --- | --- |
| Mac | MacBook Pro，M5 Pro，48GB unified memory，1TB SSD；用户随身携带 |
| Mac 模型 | Bionic + Qwen3.8-27B，128K context，模型运行时基本占满内存；这是用户提供的环境信息 |
| Windows | ROG 魔霸 6P；Ryzen 9 6900HX；RTX 3070 Ti Laptop 8GB；32GB DDR5；Windows 11 build 22631 |
| Windows 功耗补充 | 用户描述满载 180W+；未确定这是整机还是 GPU 功耗，不作为显卡 TGP 实测值 |
| 双机网络 | 已通过 ZeroTier 互通；用户平时从 Mac 用 Parsec 控制 Windows |

- 不启动、调用或修改 Mac 上的 Bionic / Qwen，不沿用其 128K context。
- 不修改现有 ZeroTier，不清理其他开发环境，不重装 Homebrew，不清空 `~/.openclaw`，不大规模清理 npm 缓存。
- 不启用 Codex 编程、GitHub 自动化、月报定时任务、银行连接或整机通用控制权限。
- Windows 本地模型已用 Qwen3-8B Q4、8192 context 完成健康检查和真实微信记账；后续性能工作再记录稳定延迟与显存余量。

## Mac 已完成且验收成功的部分

2026-09-03 已实际通过：手机微信 → 官方腾讯 iLink → Mac OpenClaw Gateway → Agent → 微信手机显示回复。用户明确确认“看到回复了”。

| 项目 | 已核验结果 |
| --- | --- |
| OpenClaw | 2026.8.2，提交 0965053；当时 npm latest 同版本 |
| 微信插件 | `@tencent-weixin/openclaw-weixin@2.4.8`，固定版本 |
| Node / npm | v22.23.1 / 10.9.8 |
| 命令路径 | `/opt/homebrew/bin/openclaw` |
| 命令实际目标 | `/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs` |
| Node / npm 路径 | `/opt/homebrew/bin/node` / `/opt/homebrew/bin/npm` |
| npm 全局目录 | `/opt/homebrew` |
| 配置 | `/Users/USER/.openclaw/openclaw.json` |
| Agent 工作区 | `/Users/USER/.openclaw/workspace` |
| 系统 | macOS 26.6，ARM64 |
| 服务 | 用户级 launchd LaunchAgent `ai.openclaw.gateway` |
| 服务定义 | `/Users/USER/Library/LaunchAgents/ai.openclaw.gateway.plist` |
| 服务 Node | `/opt/homebrew/opt/node@22/bin/node` |
| 监听地址 | `127.0.0.1:18789`，保留 token 认证 |
| 控制台 | `http://127.0.0.1:18789/` |
| 模型 | `openai/gpt-5.6-sol`，复用已有 OpenAI OAuth 登录 |
| 运行器 | OpenClaw embedded；Codex 插件显式禁用，无 Codex CLI 编程接入 |
| 微信 | 已扫码绑定，渠道 enabled / configured / running；手机收发验收通过 |

初次故障根因：onboarding 的 Codex 插件安装未取得 capability consent，Gateway 在插件校验处反复退出；当时微信插件还未安装。处理是安装官方微信插件、接受其声明的渠道能力、显式关闭 Codex 插件、把模型运行器设置为 OpenClaw，保留原 OAuth 登录。没有盲目降级或升级。

微信日志记录：04:04:21 收到入站消息，04:04:27 `outbound: text sent OK`；Agent 会话完成。另有实际模型调用返回“Mac Agent 已就绪。”。基础测试后 Gateway RSS 约 367MiB；服务参数 12288MiB 是 V8 堆上限，不是实际占用或预留内存。

当时生效的范围限制：

```text
tools.profile = minimal
plugins.entries.codex.enabled = false
plugins.entries.openclaw-weixin.enabled = true
默认模型及 main Agent 的 agentRuntime.id = openclaw
agents.defaults.heartbeat.every = 0m
cron.enabled = false
skills.workshop.autonomous.mode = off
session.dmScope = per-account-channel-peer
```

`minimal` 目前只给模型 session_status，没有文件和终端工具。接入账本时需要配置必要的账本能力，不能假定安装 Skill 后原权限就足够，也不要因此开放整个系统。

Mac 运维命令（Windows 上要按所选安装方式另行验证）：

```sh
openclaw gateway start
openclaw gateway stop --force
openclaw gateway restart --safe
openclaw gateway status
openclaw channels status --probe
openclaw plugins info openclaw-weixin
openclaw logs --follow --plain
tail -n 100 ~/Library/Logs/openclaw/gateway.log
```

补充日志：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`。认证和账号状态留在 Mac 的 `~/.openclaw`；本交接包不包含任何 token、OAuth 凭据或有效二维码。

## 记账的最终需求

### 输入、时间、币种与备注

- 默认 SGD（新加坡元），时区 Asia/Singapore。
- 每条消费消息都用模型理解和分类。用户明确不接受“正则/规则优先，仅疑难项调用模型”的旧方案。
- 一条消息记一笔支出。记录金额、一级/二级分类、时间和可选备注。
- 时间默认使用微信消息时间。腾讯插件源码已确认将 `create_time_ms` 传入 OpenClaw 的 `Timestamp`；仍需实测正确写入账本。缺失时可用接收时间并记录来源，不让模型自由编造。
- 记录时间不等于实测付款时间。用户另说具体消费时间时再处理，不能拿模型回答完成时间代替消息时间。
- 备注复用 ezBookkeeping 已有 `comment` 字段，不需要为了字段名另改数据库。当前实现只原样提取显式“备注”后的文字；下一阶段改为由本地模型根据整条消息提炼简短备注。
- 目标示例：`午饭食阁6.5+2.5` 的备注为 `食阁吃饭`；`NTUC购物8.25，买了两根芹菜，一个菜板` 的备注为 `两根芹菜，一个菜板`。只根据原文提炼，不补充消息里没有的事实。
- 用户不关心超市买了哪些商品，也不需要拆账。此例整笔 S$8.25 归“食品酒水 / 超市购物”，不因食材和日用品混合而追问分类。
- 没有地点、商品或其他有效细节时，comment 留空，微信回执显示 `无`。现有 comment 字段在核验版本中上限 255 字符；不得静默截断超长输入。
- 保存成功后才在微信确认成功；金额等汇总用账本程序准确计算，不靠模型心算。
- 重复投递同一微信消息不能新增第二笔；用户实际发送两条内容相同的消息不应仅因文本相同就被误删。

### 分类表：11 个一级分类 / 45 个二级分类

以 `config/expense-categories.json` 为机器可读源。原用户口述 43 个二级分类，现已明确增加“饮料甜品”“超市购物”，都放在食品酒水下；不添加“生鲜食材”。仅将“坐机费”规范成“座机费”。分类已导入 Windows 测试账本并核验为 11/45。

| 一级分类 | 二级分类 |
| --- | --- |
| 食品酒水 | 早午晚餐、烟酒茶、水果零食、饮料甜品、超市购物 |
| 行车交通 | 公共交通、打车租车、私家车费用 |
| 居家物业 | 日常用品、水电煤气、房租、物业管理、维修保养 |
| 交流通讯 | 座机费、手机费、上网费、邮寄费 |
| 衣服饰品 | 衣服裤子、鞋帽包包、化妆饰品 |
| 休闲娱乐 | 运动健身、交际聚会、休闲玩乐、宠物宝贝、旅游度假 |
| 医疗保健 | 药品费、保健费、美容费、治疗费 |
| 学习进修 | 数码装备、书报杂志、培训进修 |
| 人情往来 | 送礼请客、孝敬长辈、还人钱物、慈善捐助 |
| 金融保险 | 银行手续、投资亏损、按揭还款、消费税收、利息支出、赔偿罚款 |
| 其他杂项 | 其他支出、意外丢失、烂账损失 |

### 后续测试输入，不是待导入的真实支出

| 输入 | 预期金额 / 分类 / 备注 |
| --- | --- |
| 午饭12.8 | S$12.80；食品酒水 / 早午晚餐 |
| 晚饭16.8 | S$16.80；食品酒水 / 早午晚餐 |
| 橙汁2 | S$2.00；食品酒水 / 饮料甜品 |
| NTU衣服35 | S$35.00；衣服饰品 / 衣服裤子 |
| 蜜雪冰城2.5 | S$2.50；食品酒水 / 饮料甜品 |
| 网线12.19 | S$12.19；学习进修 / 数码装备 |
| 麦当劳15.7 | S$15.70；食品酒水 / 早午晚餐 |
| NTUC购物8.25 | S$8.25；食品酒水 / 超市购物 |
| NTUC购物8.25，买了两根芹菜，一个菜板 | S$8.25；食品酒水 / 超市购物；备注“两根芹菜，一个菜板”；只新增一笔 |

FairPrice 也可整笔记入超市购物，不需要从商户名推断购买明细。这是最新确认的需求，取代旧调研中“分类不明应追问”的超市例子。

## 选型结果：优先原版 ezBookkeeping

项目：[mayswind/ezbookkeeping](https://github.com/mayswind/ezbookkeeping)。Windows 已部署正式版 v1.6.1（2026-07-20）的 x64 二进制；关键接口同时对照 v1.6.1 标签源码核验。

可直接复用的能力：两级分类、SQLite、多币种/时区、交易时间、备注、账本 UI、查询统计、导入导出。项目为 MIT 许可；可以按许可 fork 修改，但上述需求暂不需要重写账本或另做前端。

作者提供 OpenClaw 兼容 Skill，以及 PowerShell/Shell API 脚本；程序也有原生 MCP。优先选择其中一条可验证的集成路径，避免同时接两套重复写入工具。

- [作者的 OpenClaw 指南](https://ezbookkeeping.mayswind.net/agent/openclaw)
- [Skill 指南](https://ezbookkeeping.mayswind.net/agent/skill)
- [原生 MCP 文档](https://ezbookkeeping.mayswind.net/mcp/)
- [分类 API](https://ezbookkeeping.mayswind.net/httpapi/transaction_category_api)
- [正式发行页](https://github.com/mayswind/ezbookkeeping/releases/tag/v1.6.1)

已核验的接入细节，执行前按实际版本复核：

- Windows 服务实际使用 `D:\Clawbot\ezbookkeeping\ezbookkeeping.exe server run`；因系统端口排除范围避开默认 8080，固定绑定 `127.0.0.1:8180`。
- 作者 Skill 已作为参考安装后停用；`minimal` 工具配置不开放通用命令执行。当前使用专用最小权限插件直接调用 API。
- 原生 MCP 默认关闭；启用后使用 `/mcp`、Streamable HTTP 和专用 Bearer token。API token 与 MCP token 不可混为一谈。
- `add_transaction` 接受 RFC3339 时间、二级分类名、账户名、字符串金额、comment 等；底层金额使用整数保存。
- 专用适配层以 `channel + 微信 message_id` 为持久去重键，并把其哈希作为 `clientSessionId`；同 ID 重放不新增，文本相同但 ID 不同的消息分别入账。
- 腾讯插件 2.4.8 原实现会随机生成 `MessageSid`。本地变体只把 `message_id` 映射为稳定 `MessageSid`，缺失时保留官方随机回退；不改消息文本、时间、认证和收发逻辑。
- 适配层校验金额、类别存在性、可信元数据、备注长度和写入结果，不代替模型做语义分类或备注提炼；只有确认写入后才回复成功。
- `message_received` hook 与 `record_expense` 可能位于隔离的插件实例，可信消息桥因此写入同一台 Windows 上的短时 SQLite 表。session/sender 查询键先做 SHA-256，记录十分钟过期；消息 ID 仍用于写入去重。

此前候选仅作为调研记录：FinancialClaw 有原生插件但 Node >=24、分类/时间结构需适配；名字叫微信 ClawBot 记账 Agent 的项目实际是 Flask 服务且偏规则解析；Actual Budget 可用但对当前两级分类和时间要求，ezBookkeeping 的现成集成更直接。不要退回旧“规则优先 / Actual Budget 优先”建议。详见 `research/accounting-options.md`。

## Windows 模型起点

当前使用 Ollama 0.33.2 的 `qwen3:8b` Q4，8192 context、thinking off。4096 context 曾因系统提示与工具 schema 超限导致工具桥接误用；提升到 8192 并关闭 Tool Search 后，模型已完成只读健康检查和一次真实微信消费写入。更多类型的分类准确率仍需逐步验收。

用户所说“中等/较低推理档位”表示不要为简单记账耗费过多推理时间。Qwen 的思考开关与 Codex medium 不是同一套参数：可测试非思考或短思考，但每条消费依然由模型理解。用完整分类表和少量个人偏好作为上下文，不把所有聊天和项目资料都塞进去。

还需验证小模型在所选运行时中的工具调用/结构化输出是否稳定，不仅能聊天。模型失败不得静默回退到 Mac 的 27B，也不要未经说明将账目转发给云端模型。

参考：[Qwen3-8B 模型说明](https://huggingface.co/Qwen/Qwen3-8B)、[Qwen3.5-9B 模型说明](https://huggingface.co/Qwen/Qwen3.5-9B)。

## Windows 执行顺序与验收

1. **已完成——读环境**：系统、硬件、端口、电源、Node/OpenClaw/Ollama 均已实测。
2. **已完成——部署测试账本**：原版 ezBookkeeping、SGD “日常支出”账户和 11/45 分类均已核验。
3. **已完成——部署小模型与只读工具调用**：Qwen3-8B 在 8192 context 下直接调用账本工具成功。
4. **已完成——接入最小权限记账工具**：消息时间、稳定 ID、跨实例可信元数据、SQLite 去重与失败回复已通过 13 项测试。
5. **已完成——切换 Windows 微信接收端**：Windows 渠道 enabled/configured/running，Mac 已停止。
6. **已完成——真实写入验收**：用户从手机发送消费，Qwen 调用工具，写入确认后微信返回“已记账”。
7. **下一步——丰富确认回执**：本地模型提炼备注；工具返回账本、SGD 金额、分类、备注和 Asia/Singapore 可信时间的固定表单。
8. **后续——家庭网页查看**：单独设计 Vercel 托管、同步、认证、授权、备份和审计边界，不直接暴露 Windows 本地账本。

若 Windows 失败，先定位 iLink、Gateway、模型、工具或账本哪一层出错并查看日志。保留 Mac 配置作为恢复基础；必要时停 Windows 接收，再尝试恢复 Mac，账号是否需要重新扫码以实际结果为准。

## 交接文件与迁移边界

- `WINDOWS-HANDOFF.md`：本文件，Windows 新会话的第一入口。
- `config/expense-categories.json`：已导入并核验的 11/45 分类源。
- `docs/expense-categories.md`：分类及备注规则的可读版。
- `docs/bookkeeping-deployment-brief.md`：记账部署方案和已有核验结果。
- `README.md`：Mac 第一阶段安装、故障根因、运维与验收记录。
- `openclaw-plugins/clawbot-bookkeeping`：专用最小权限账本插件与测试。
- `openclaw-plugins/openclaw-weixin-stable-id`：腾讯微信插件 2.4.8 的稳定消息 ID 本地变体与补丁说明。
- `scripts/initialize-test-ledger.ps1`：可幂等核验或初始化测试账户和分类的脚本。
- `research/accounting-options.md`：历史选型证据，最新要求覆盖旧建议。

本项目保存文档、配置源、初始化脚本和本地插件代码，但不是完整 OpenClaw/账本状态备份。Mac 的 OAuth/微信认证未打包；Windows 的密码、API token、Gateway token、SQLite 数据与微信认证也不得提交或发到聊天。重新部署时仍需单独恢复程序状态和受限凭据。
