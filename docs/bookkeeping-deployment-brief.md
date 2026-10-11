# 微信账本助理部署方案

更新时间：2026-10-11。参考部署已迁至 Apple Silicon Mac Docker；Windows 原生部署接口继续维护。家庭网页复用 ezBookkeeping UI，通过专用 Cloudflare Tunnel 发布，SQLite 留在选定本地主机，不部署账本 Vercel。当前业务 release 见 [图片语义校验发布记录](handoffs/2026-10-11-image-semantic.md)，宿主修复与运行验收见 [Mac 工作清单](mac-before-windows-checklist.md)。

## 已定方案

```text
WeChat -> OpenClaw immutable release -> owner-bound OpenAI GPT-5.6 Sol (official Codex harness)
  -> record_expense | prepare_expense | resolve_expense_confirmation
     -> trusted write/confirmation adapter -> 127.0.0.1:8888 ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
     (local MCP enabled; live WeChat history query verified)

Browser -> https://ledger.66ccff-labs.com -> Cloudflare Tunnel
  -> health-gated 127.0.0.1:8888 -> the same ezBookkeeping and SQLite
```

手机微信是输入与回复入口，腾讯 iLink 将消息交给选定本地主机的 OpenClaw。专用 `bookkeeper` 使用 OpenAI `gpt-5.6-sol`，并通过官方 `@openclaw/codex` harness 和 ChatGPT OAuth 理解账本意图；ezBookkeeping 1.6.1 在 `127.0.0.1:8888` 保存和查询本地 SQLite 数据，测试实例单独使用 `127.0.0.1:18888` 和独立 SQLite。Gateway 也只绑定 loopback。该云端模型处理已获用户明确授权，账本请求和必要查询结果可进入当前 ChatGPT OAuth 下的 Codex 会话。本机 token、Cloudflare 身份、微信身份、消息 ID、SQLite、交易数据、日志和 OpenClaw 状态不得提交到 Git、公开发布或导出至未授权服务。

HTTP 写入、对话确认和确定性汇总已经建立。ezBookkeeping 原生 MCP 是否启用、独立 MCP token 是否存在以及 Ledger 公网入口是否完成，必须以本机/公网实时验收为准；代码或文档存在不能替代端到端证据。

正式写入按币种路由至“多币种支出”的 159 个子账户；旧 SGD 账户 `日常支出` 及历史保留，查询覆盖这组经过核验的账户，微信回执显示账本名 `日常账本`。运行时以 `openclaw-plugins/clawbot-bookkeeping/categories.mjs` 中不可变的 `CATEGORY_DEFINITIONS` 为权威分类契约，固定为 11 个一级分类、45 个二级分类；`config/expense-categories.json` 只是脱敏的导入与部署目录快照。二级分类的显示图标另记于 `config/expense-category-icons.json`，不参与分类判断，也不由运行时自动覆盖；当前设置见 [分类说明](expense-categories.md)。

Mac 宿主约每 15 秒将容器、存储和资源状态写入本机私有轮转日志，命令失败和故障前样本单独保留；看板只显示记录器健康，不开放日志下载。源码提交与不可变运行包分别标识。2026-10-03 宿主修复将明确的瞬态测量失败与硬存储错误分开：健康原实例可在最近完整安全样本后不足 60 秒内继续运行，超期或无安全基线则暂停，完整安全复检后恢复。硬错误、未分类错误和已有故障锁仍需保护与人工审核。检查入口、容量与状态处理见 [运行诊断](mac-runtime-diagnostics.md)。专用插电主机的系统禁睡眠与 [合盖息屏辅助任务](mac-lid-display-sleep.md) 分别配置和验收。

## 为什么采用混合接入

写入继续使用定制工具。`record_expense` 处理明确支出；`prepare_expense` 将需要澄清的完整候选存为十分钟待确认提案且不写入账本；图片候选可能只读核查原交易是否存在；`resolve_expense_confirmation` 只接受可信当前消息中的简短确认或取消，并在确认后复用原消息时间和同一套写入事务。它们关联可信微信元数据，以 `channel + messageId` 持久去重。SQLite 的 ended_trusted_runs 保存结束运行撤销，processed_expense_confirmations 持久去重确认消息哈希，receipt_store_migrations 记录一次性历史哈希导入；升级保留这些记录。短期工具绑定、待确认提案和权威回执交接均存在本地 SQLite，确认或回执发送跨插件实例时仍可恢复；回执候选不唯一则失败关闭。原生 MCP 的 `add_transaction` 没有这层消息关联和去重，因此绝不向代理开放。

单张图片通过微信接收端的 `AsyncLocalStorage` 关联当前已鉴权消息、发送者和附件；记账插件复核真实入站记录、受控媒体目录、类型、大小及文件哈希，不由模型指定路径或身份。支持 JPEG、PNG、WebP，上限 10 MiB。模型的 `imageEvidence` 是独立的提取结果，不写回可信文字正文。当前使用 `semanticVersion=2`：AI 按语义核对实际金额与币种、消费日期、用途，确认是一笔已发生支出即可直接入账，不要求固定标签。现行规则为缺日期先追问，缺用途备注“无”，成功转出默认按支出，仅明确本人账户间划转时排除，不追加收款账户归属追问。金额、币种或消费性质有合理候选且仍不明确时才编号确认。Mac `9d89ed2` 已部署，测试集见 [100 张真实图片](../test-cases/image-semantic/README.md)。

回执库中的 `image_expense_links` 保存用户范围内的图片防重关联，`image_expense_proposals` 保存图片候选及原图时间。新消息重发时查询关联的原交易，仍存在则防重；明确已删除才解除旧图片及订单关联，允许重新记入。查询失败时停止，原消息和永久确认记录保持。每会话最多十笔有效候选，十分钟过期；回复“确认第3笔”或“取消第3笔”，有多个候选时不能用无编号回复猜选。普通查询保留图片候选，迟到的旧识别结果仍不能覆盖当前回复。升级备份须保留完整回执库，包括这两张表和所有原有永久确认记录。具体规则见 [图片记账设计](superpowers/specs/2026-10-01-image-bookkeeping-design.md)。

源码新增的写入前原图复核使用同一官方 Codex 模型和运行时接口，重新读取已校验哈希的附件，使用完整图及三块或六块重叠放大细节；复核值仍通过原有金额、时间、账户、类别与授权校验。复核失败明确返回未入账，不跳过复核继续写。该额外调用会增加图片处理时间；原始附件和防重键不变。慢识图的输入关联只有在运输端图片身份精确匹配时可使用既有十分钟有效期，文字仍为 60 秒，run 撤销与写前权限检查保持。Mac 已完成隔离验证和生产发布，Windows 原生媒体链路需另行验证，见[发布记录](handoffs/2026-10-11-image-real.md)。

读取分三条路径：

- `summarize_expenses` 通过 HTTP API 读取经核验的账户范围内的支出，由代码按整数分计算今天、本周、本月、上月、今年或自定义范围内的总额、笔数、一级分类汇总和最大三笔。它可按正式分类或备注关键词过滤；原币分别汇总，目标币种用精确十进制计算换算，不依赖模型心算。单条消息的多个读取问题可通过 `questions` 一次回答，汇率缓存每日零点更新。
- `find_expenses` 通过 HTTP API 按整数分精确匹配经过核验的账户范围内的原币金额，默认查询全部历史，也可指定日期范围；默认返回最近 3 笔、最多 10 笔，有更多记录时明确提示。它不遍历后续页，失败或分页不完整时不得声称没有记录。
- `ezbookkeeping__query_transactions` 回答历史记录等只读问题。Windows 使用 requester-scoped 原生 MCP，Mac 使用官方 MCP SDK 的受限动态工具适配；两条路径都保留固定 owner、旧账户及多币种子账户范围、十条上限、分页验证和可读回执，不开放原生写工具。代理使用 `tools.profile=full` 与六项精确 `allow`，避免 minimal profile 提前过滤历史工具。

Codex 按语义区分写入、待确认、取消和查询；插件不使用商户白名单代替语言理解。消息里出现日期、数量或“支出”不等于要写入；只有明确表达已发生消费且金额明确时才调用一次 `record_expense`。`午饭7.2吗` 先返回完整确认单，单独回复“是的”“没问题”“确认”等才入账；“取消”“不记”“拉倒”等取消待确认提案，不删除历史交易。新的实质消息会废弃旧文字提案并按新请求处理；图片候选按编号独立保留。问号不视为确认标点。专用模型以 `agentRuntime.id: codex` fail closed，不自动退回 Qwen 或其他模型。

## 写入与回执契约

- 文字未声明币种时默认 SGD；时区固定 `Asia/Singapore`。图片有明确币种或地区依据时按原币；用户于 2026-10-11 指定无币种信息默认 SGD，包括无其他线索的孤立 `$`。明确币种冲突仍澄清，不能用默认覆盖。
- 腾讯消息时间戳由可信元数据提供，插件统一规范为 Unix 秒；毫秒值会先换算为秒。插件只在已关联的所有者记账轮向 Codex 注入该发送时间，用于换算本条用户文字中的“昨天”等相对日期，不暴露消息 ID 或身份值。
- 用户明确写了消费日期或具体钟点时，Codex 提交结构化日期、可选钟点和原文时间证据，插件校验后将实际消费时间写入账本；只给日期时保留发送时分。“中午吃饭”“晚上吃饭”和“午饭”“晚饭”一样是消费描述，没有另外写日期或具体钟点时完整使用可信消息发送时间。最终 API 时间和回执时间来自同一个值，晚于发送时间超过 5 分钟的结果会在写入前被拒绝。
- 图片可采用付款、支付、交易、下单、订单创建或购买时间，优先付款时间，排除物流和手机状态栏时间。由 AI 理解不同语言和日期写法；工具的 `localTime` 为 HH:mm，秒数通过 `imageEvidence.localSecond` 保留。只有日期时沿用原图收到时分并说明；没有可用日期必须先询问，不再采用收图日期；旧截图里的“昨天”等相对日期不能借收图当天换算，需要图内或本条用户补充明确截图日期。订阅服务期、下一次续费也不能替代实际付款日。确认后仍用原图信息，不追改历史账目。
- 明确声明的币种按原币入对应子账户，支持全部 159 个 ISO 代码及明确名称。查询可按中行现汇卖出价换算，详细别名、精度和缺价处理见 [多币种与汇率](multicurrency-and-rates.md)。
- 一条消息最多新增一笔。共享源码支持加、减、乘、除，先乘除后加减，同级从左到右；金额精确到分，不舍入。`10-3.8` 为 6.20，`6.7*0.9` 为 6.03。数字间 `/` 或 `／` 默认除法但必须先拟单，例如 `3.8/2` 返回 1.90 的完整确认单，确认后才写入；“备注”之后的斜杠与数字不参与计算。独立负数、非正结果、除零或无法精确到分时不直接写账。源码／上线验收分别见 [四则运算记录](handoffs/2026-10-04-arithmetic.md)。
- 用户显式写“备注”时保留其后的原文；否则模型只可提炼原消息明确出现的商家、商品或用途。普通文字没有有效细节时 comment 留空，回执显示“无”；图片直接保存字面值“无”，不追问用途。
- 备注不得超过 ezBookkeeping 的 255 字符限制，不得静默截断。

只有 ezBookkeeping 明确确认创建并返回交易 ID，才发送成功回执：

```text
记下来啦！🧾
- 账本：[ 日常账本 ]
- 支出：7.20 SGD
- 分类：食品酒水 - 早午晚餐
- 备注：无
- 时间：2026/09/03 16:21
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
- HTTP 汇总失败：`账本暂时连不上，这次没有读取任何数据～ 稍后再试试吧。`
- 汇总参数在执行前被拒绝、同一可信请求修正参数后成功时，采用成功结果；实际执行出错或结果不确定仍保留相应失败保护。见 [查询重试修复](handoffs/2026-09-30-query-retry-repair.md)。
- MCP 历史查询失败：同样回复 `账本暂时连不上，这次没有读取任何数据～ 稍后再试试吧。`，不重试，不展示底层错误。
- 信息不足：只追问缺失金额、日期或意图，不再统一回复“记账失败，请重新发送一条新消息”。

## 所有者限定的 MCP

下面的 connection resolver 与 Windows 文件权限说明用于原生 Windows 路线。Mac 固定 Linux 镜像不声明原生 MCP server，由受限 SDK 适配提供同名工具，凭据使用显式卷路径；详见 [Docker 说明](../deploy/docker/README.md)。

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

ezBookkeeping 正式目录为 `D:\Clawbot\ezbookkeeping`，配置文件为 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。正式任务只接受精确动作 `ezbookkeeping.exe --conf-path "...\ezbookkeeping.ini" server run`；未知同名任务不能被 `-Force` 覆盖。迁移前必须重新验证旧任务、PID、创建时间、程序路径、完整命令行、`8180` owner 与 health，然后在仓库外备份并验证任务定义、INI 和 WAL-safe SQLite 快照。

正式配置固定 loopback `8888`，服务端关闭注册和无效密码找回，失败登录限制保留为每 IP/用户每分钟 5 次，API token、MCP 与 trusted proxy allowlist 只接受 `127.0.0.1`。`enable_mcp` 保留部署前实际选择。Process/User/Machine 范围任何能覆盖这些 INI 键的 `EBK_CONF_PATH`、`EBK_*` 或 `EBKCFP_*` 都使迁移失败关闭。

测试目录 `D:\Clawbot\ezbookkeeping-test` 只白名单复制程序资产，使用 `18888`、独立 config/storage/log/secret/token/SQLite 和受控 marker；不得复制正式数据。初始化密码只在 visible terminal 以 `Read-Host -AsSecureString` 输入。

已部署主机的续接先按 [正式切换记录](handoffs/2026-09-09-production-cutover.md) 只读核对，不重跑安装或初始化。以下为不同安装状态的独立入口，先用 `-WhatIf` 预演；预演不得修改配置、计划任务、服务或 token，也不会询问密码。

首次安装且没有同名任务时，在程序与显式配置已经就绪后创建正式任务；预演核对无误后才去掉 `-WhatIf`：

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
```

已有旧 `8180` / `server run` 任务时，直接使用迁移入口识别、备份并转换旧任务。不要先调用只接受显式配置动作的任务安装器；预演核对通过后，用同一参数去掉 `-WhatIf` 执行迁移。脚本在实际转换前创建并校验备份，`-WhatIf` 不创建备份：

```powershell
.\scripts\migrate-ledger-production.ps1 -WhatIf
```

隔离测试实例单独安装；核对独立目录与状态后去掉 `-WhatIf`，再按运维手册进行交互初始化：

```powershell
.\scripts\install-ledger-test-instance.ps1 -WhatIf
```

发布与切换使用 [运维手册的两阶段流程](ledger-cloudflare-runbook.md#5-发布并切换正式-openclaw-release)：先真实发布并验证 release，再显式指定同一 release 路径切换正式 OpenClaw。

生产 OpenClaw 不再加载 Git checkout。发布器从干净且 HEAD 不变的提交创建 immutable release，使用 lockfile 安装运行依赖，对全部 payload 记录长度和 SHA-256，并拒绝 missing/extra/changed/reparse/out-of-root。切换前只生成不含 token/owner/channel 的最小 patch，先 dry-run；任何 post-patch 失败恢复 owner-only 配置备份并重启 Gateway。

MCP 激活是独立可选操作，不属于 Ledger 网页上线的默认步骤。本机已于 2026-09-07 经用户授权完成激活与真实微信查询验收，不应重复生成令牌。以下命令仅供尚未激活且所有者明确选择开通的部署，在可见终端预演并执行：

```powershell
.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
.\scripts\configure-ezbookkeeping-mcp.ps1
```

MCP 配置脚本会：

1. 解析 `[mcp]` 并只把 `enable_mcp` 与 `mcp_allowed_remote_ips` 改为 `true` 和 `127.0.0.1`；
2. 原子创建不覆盖的时间戳备份，并原子替换配置；
3. 校验根目录中恰好一个同名任务，且可执行文件、显式配置参数和工作目录完全匹配；
4. 停止前复核 PID/创建时间/路径/命令行/端口 owner，只控制已识别进程，重启任务并等待 `8888` `/healthz.json` 返回 `success=true`；
5. 在控制台安全读取密码，通过现有 API token 生成独立 MCP token，并写入仅当前用户可读的文件。

中途失败会尝试恢复原配置和先前服务状态。若自动回滚也失败，脚本错误会给出应手工恢复的备份路径；恢复后再重新运行。脚本不会打印密码、请求体、Authorization header 或 token。

## Ledger Cloudflare Tunnel

`ledger.66ccff-labs.com` 是唯一公网 hostname；origin 固定 `http://127.0.0.1:8888`，最后一条 ingress 必须是 `http_status:404`。只保留 ezBookkeeping 登录，不启用 Cloudflare Access。`66ccff-labs.com` 与 `www.66ccff-labs.com` 的作品集 DNS、Vercel 路由和页面均不修改。

本机 supervisor 在启动 cloudflared 前连续验证唯一 loopback listener、PID/创建时间、预期 ezBookkeeping 可执行路径、显式 production config、health JSON 和登录页指纹。运行中任何条件退化都只停止自己创建且身份仍匹配的 cloudflared child，公网 fail closed；未知端口 owner 或未知 cloudflared 不会被终止、采用或替换。

Cloudflare 使用 Ledger-only Single Redirect、Cache Bypass、Response Header Transform、registration/TRACE WAF 和套餐支持的登录限速。不设置 zone-wide Always Use HTTPS/HSTS，不启用 Access。Free plan path-only 限速只有在实时证明 apex/`www` 均不使用 `/api/authorize.json` 且唯一规则槽空闲时才可启用；否则跳过并记录。Universal SSL、规则和 Tunnel 都通过后 DNS cutover last。

需要 Cloudflare 登录时只打开 visible terminal/browser 让用户本机授权，不索取或回显凭据。真实 Tunnel config/JSON、备份、SQLite 和脱敏 evidence 均位于 Git/仓库/OneDrive 之外。完整步骤、表达式、验收和 rollback 见 `docs/ledger-cloudflare-runbook.md`。

## 验证

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

Set-Location ..\..\
openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
```

本机、公网与重启验收使用 [运维手册](ledger-cloudflare-runbook.md) 的完整参数和顺序；恢复当前部署时先看 [Mac 工作清单](mac-before-windows-checklist.md) 和 [2026-09-16 微信换绑恢复](handoffs/2026-09-16-weixin-rebind-recovery.md)，再按手册验证，不重复早期已完成的部署步骤。

动态 MCP 只由插件 manifest 和 requester-scoped resolver 声明，不得为诊断方便新增顶层 `mcp.servers` 静态连接。任何运行时配置或部署变更前，必须先执行 `WINDOWS-HANDOFF.md` 的只读属性名断言；若顶层 `mcp.servers` 下存在 `ezbookkeeping`，停止部署并另行审核移除，不能自动删除或显示其内容。该断言与账本插件自动化测试共同证明没有静态后备项，且 manifest、resolver 和代理 allowlist 只允许 `query_transactions`、源码和测试明确排除 `add_transaction`；stable-ID 插件另有独立测试。由所有者在微信核对写入、确认及支持的 HTTP 汇总不会越权；仅在 MCP 已激活后，再以真实历史查询闭合该动态连接的端到端证据。未激活时记录为未启用，不为完成网页验收而生成 MCP token。

仓库秘密扫描从当前项目根目录取得 Git tracked-only 清单，先拒绝禁止的数据路径和链接，再读取内容；不得跳过测试或示例目录，也不得递归读取 `.worktrees`、ignored 文件或运行时数据。输出只含文件位置、规则名称和计数，不返回匹配正文。每条匹配须人工核验，不能因它位于 fixture/example 中就自动视为安全。具体命令和处置标准见 `WINDOWS-HANDOFF.md`。

## 明确排除与后续事项

本轮不把账本部署到 Vercel/云数据库，不开放 origin 端口，不同步 SQLite/交易到 Git，不建立 Cloudflare Access 双重登录，也不实现家庭多用户或共享权限。经用户明确授权，账本请求与必要查询结果可进入当前 ChatGPT OAuth 下的 Codex 会话；不得发送到其他云端模型或服务。

上线后仍需定期更新 ezBookkeeping 和 cloudflared；每次更新先备份并在 `18888` 验证。建议用户在稳定后启用 ezBookkeeping 原生 2FA/WebAuthn，它仍属于同一次应用登录。正式 SQLite 另保留不经过 Git 的加密离机备份；数据库恢复永不自动执行。
