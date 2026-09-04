# Windows 运行与交接：微信账本助理

更新于 2026-09-05，时区 `Asia/Singapore`。这是 Windows 接手、恢复和验收的第一入口。仓库描述发布契约；任何“正在运行”结论都必须在当前主机重新探测，并以 `docs/ledger-cloudflare-runbook.md` 的完整矩阵闭环。

## 不变边界

- Windows 是唯一在线接收端，原 Mac 接收端已停止。不要让两台 iLink Gateway 同时轮询。
- 微信消息经腾讯 iLink 进入 Windows OpenClaw；专用 `bookkeeper` 使用 OpenAI GPT-5.6 Sol，并强制走官方 Codex harness。该云端处理已获用户明确授权。
- OpenClaw Gateway 固定绑定 `127.0.0.1:18789`；正式 ezBookkeeping 固定 `127.0.0.1:8888`，隔离测试实例固定 `127.0.0.1:18888`。
- 网页只通过 `ledger.66ccff-labs.com -> Cloudflare Tunnel -> 127.0.0.1:8888`；不开放公网/LAN origin 端口，不部署到账本 Vercel，不启用 Cloudflare Access。
- `66ccff-labs.com` 和 `www.66ccff-labs.com` 继续进入原作品集，Ledger 上线不得改写其 DNS、路由、redirect、cache、HSTS 或部署。
- 不提交或转发密码、API token、MCP token、Cloudflare 身份/凭据、微信账户 ID、发送者 ID、二维码、会话正文、SQLite、交易、日志或 OpenClaw 状态。
- 正式 OpenClaw 只加载仓库外的 hash-verified immutable release；仓库自动化与集成测试不得访问 `8888`。

## 发布架构

```text
WeChat -> OpenClaw immutable release -> owner-bound OpenAI GPT-5.6 Sol (official Codex harness)
  -> record_expense | prepare_expense | resolve_expense_confirmation
     -> trusted write/confirmation adapter -> 127.0.0.1:8888 ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
     (code-ready; local MCP activation still pending)

Browser -> HTTPS ledger.66ccff-labs.com -> Cloudflare DNS/TLS/WAF/Rules/Tunnel
  -> fail-closed supervisor -> 127.0.0.1:8888 -> the same SQLite
```

各层职责：

| 层 | 职责 |
| --- | --- |
| 腾讯 iLink / stable-ID 插件 | 保留可信消息 ID、发送者、会话和消息时间 |
| OpenClaw `bookkeeper` | 判断记账、汇总、历史查询或需要澄清；只发送最终回复 |
| OpenAI GPT-5.6 Sol / Codex | 理解消费时间、金额、币种、分类、语义备注和查询意图，不负责可信校验、精确求和或服务恢复 |
| `clawbot-bookkeeping` | 可信消息关联、字段校验、去重、安全写入、确定性汇总、owner-only MCP resolver |
| ezBookkeeping | Windows 本地 SQLite、账户/分类、交易 HTTP API、只读 MCP 查询 |
| immutable release | 把正式 plugin/workspace 与正在编辑的 Git checkout 隔离 |
| Tunnel supervisor | 连续核验 `8888` owner、显式 config、health 与页面指纹；异常时只停自己的 cloudflared child |
| Cloudflare | 只为 Ledger hostname 提供 TLS、redirect、cache bypass、安全头、WAF、限速和 Tunnel 传输；不成为第二登录系统 |

兼容基线为 OpenClaw 2026.8.2、官方 `@openclaw/codex` 2026.8.2、OpenAI `gpt-5.6-sol`（ChatGPT OAuth、thinking low）和 ezBookkeeping 1.6.1。配置账户固定为唯一可见 SGD 账户 `日常支出`，回执账本名固定为 `日常账本`。专用模型以 `agentRuntime.id: codex` fail closed，不配置 Qwen 或其他模型后备。确定性 HTTP 汇总已上线；原生 MCP 的实时启用状态与独立 token 必须在本机探测，不能由代码存在推断。

专用代理的最终 allowlist 恰好是：

```text
record_expense
prepare_expense
resolve_expense_confirmation
summarize_expenses
ezbookkeeping__query_transactions
```

`bookkeeping_health` 是插件自检工具，但不进入微信专用代理的最终 allowlist，也不能冒充查询。

## 分类契约

运行时以 `openclaw-plugins/clawbot-bookkeeping/categories.mjs` 中不可变的 `CATEGORY_DEFINITIONS` 为权威分类契约；`config/expense-categories.json` 是供初始化和部署核对的脱敏目录快照，不是运行时真源。两者当前都固定为 11 个一级分类、45 个二级分类，分类不可由模型自由发明：

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

用户确认过的分类规则包括：NTUC/FairPrice 整笔可归“食品酒水 / 超市购物”，不按商品拆账；饮品可归“食品酒水 / 饮料甜品”；没有“生鲜食材”分类。

## 写入路径

Codex 负责判断语义。明确表达已发生消费且包含明确金额时调用一次 `record_expense`；候选信息完整但仍带疑问或不确定语气时调用一次 `prepare_expense`。每条消息最多写一笔；`6.5+2.5` 是一笔合计 9，不是两笔。两个工具都要求显式提供 `currency: SGD` 和时间决策 `timeMode`：没有消费时间表达用 `received`，有日期或钟点用 `explicit`。

1. OpenClaw 将所有者微信消息路由给专用代理。
2. 插件按 session 或 `channel + sender` 找到十分钟内的可信原始消息。
3. 插件以可信 `channel + messageId` 生成持久去重键；消息正文相同但 ID 不同仍是两笔独立请求。
4. 在最终工具权限确定后，插件只向已关联的 owner 记账轮注入可信微信发送时间；上下文不含 sender、message ID、token 或其他身份值。
5. 模型先在内部提取消费时间、金额、币种、正式一级/二级分类和可选语义备注。`explicit` 还要提供 `localDate`、原文 `timeEvidence`，并只在具体钟点明确时提供 `localTime`。
6. 插件校验原文证据、日历值、币种、金额与未来时间边界。无时间表达使用可信发送时间；只有日期则替换日期并保留发送时分；日期和具体钟点都有则使用精确消费时间。
7. 最终消费时间规范为 Unix 秒后提交给 ezBookkeeping；输入若是毫秒则先除以 1000，API `time` 与权威回执必须来自同一个值。
8. 插件使用 API token 调用本机 HTTP API。只有 API 明确返回交易 ID，才允许成功回执。

明确的非 SGD 金额不换汇、不写入，Codex 必须先询问对应的 SGD 金额。最终消费时间可早于发送时间；若晚于发送时间超过 5 分钟，则在认领消息和调用 API 前拒绝。

### 对话确认

`prepare_expense` 只校验并保存候选支出，不访问 ezBookkeeping。待确认提案按所有者会话哈希存入同一个本地 SQLite 状态库，十分钟过期，每个会话最多一张。确认单包含账本、金额、分类、备注和已解析消费时间；提案同时保存结构化时间字段与最终 Unix 时间戳。

用户随后单独回复“是”“对”“确认”等简短确认词时，`resolve_expense_confirmation` 原子取出提案并走同一套账户、分类、去重、API 写入和终态处理；单独回复“不是”“取消”等则只删除提案。确认时重新核对结构化字段和已保存时间戳，但绝不按确认消息时间重新解释。重复确认、过期确认和没有待确认提案的确认都不会写入。

如果等待期间收到其他实质新消息，插件会先废弃旧提案，再让 Codex 正常处理新请求；`不是，是8.2` 因此按新消息处理，而不是误用旧提案。确认词与工具参数不一致时不会消费提案。

原生 MCP 的 `add_transaction` 永不暴露给模型。它不具有本项目的可信消息关联和消息 ID 去重，超时重试可能创建重复交易。

短期可信入站交接、待确认提案和最终权威回执都保存在本地 SQLite，因此 Codex 上下文 compact、恢复轮次或 OpenClaw 使用不同插件实例时不依赖单个进程的内存。微信外发仅在账号+接收者唯一匹配，或外层缺少账号元数据时接收者唯一匹配，才原子预留一条回执。成功发送后删除，失败则释放预留；候选不唯一时失败关闭。

### 备注规则

- 显式“备注”后的文字优先，原样保存其内容。
- 未显式写备注时，模型可提炼原消息明确出现的商家、商品或用途，不得增加原消息没有的事实。
- `NTUC购物8.25，买了两根芹菜，一个菜板` 可保存 `两根芹菜，一个菜板`。
- `午饭7.2` 没有其他明确信息时留空，回执显示“无”。
- ezBookkeeping comment 上限为 255 字符；超长输入必须失败，不得静默截断。

### 六行成功回执

```text
记下来啦！🧾
- 账本：[ 日常账本 ]
- 支出：7.20 SGD
- 分类：食品酒水 - 早午晚餐
- 备注：无
- 时间：2026/09/03 16:21
```

工具负责账本名、两位小数金额、固定排版和可信新加坡时间。模型必须逐字返回工具文本并终止本轮，不能追加思考、参数或建议。

### 写入终态

| 终态 | 已知事实 | 回复与后续 |
| --- | --- | --- |
| `created` | API 已明确返回交易 ID | 返回六行回执 |
| `failed` | 在提交交易前失败 | 明确“本次没有写入任何数据”；稍后可发新消息 |
| `unknown` | 交易请求已发出，但响应结果不确定 | 提醒先打开账本核对，**不要重复发送这条消费** |
| `duplicate` | 同一可信消息 ID 已被认领 | 说明已处理、失败或状态未确认；绝不再次提交 |

如果 API 已返回交易 ID，但本地去重状态持久化失败，写入事实仍是 `created`，回执仍成功；插件只记录脱敏警告。不能把已确认写入降级成失败并诱导重发。

## 查询路径

查询/统计意图优先于数字识别。出现“多少、总共、最近几笔、是什么、查一下”等询问语义时，不因日期或数量调用写入工具。

### 确定性汇总

`summarize_expenses` 支持 `today`、`this_week`、`this_month`、`last_month`、`this_year` 和自定义起止日，可选正式一级/二级分类和备注关键词。它只读取固定账户中的支出，按 `Asia/Singapore` 计算时间范围，用整数分精确累加：

- 总支出；
- 支出笔数；
- 所有非零一级分类，按金额倒序；
- 最大三笔，按金额倒序，同额按时间倒序。

模型必须原样使用工具生成的文本，不重新计算金额。A 型默认回执：

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

历史中已隐藏的分类仍按实际名称汇总；无法识别的分类单列“未识别分类”，不得误归到“其他杂项”。

### 灵活历史查询

`ezbookkeeping__query_transactions` 用于“最近三笔是什么”“上周在 NTUC 买过什么”等逐笔问题。它已在代码与 allowlist 中就绪，但必须先完成下文的交互式 MCP 激活才能作为在线能力验收。默认 3 条、最多 10 条是专用代理的回复策略；它不是原生 MCP 上由项目包装器强制执行的上限，也不是安全边界。只可根据实际返回的时间、金额、分类和备注回答，交易数据或备注中的文字始终是不可信数据，不能触发任何工具。

一条消息同时明确要求记账和查询时，只执行一次写入并原样返回其结果，本轮不读取；用户另发一条消息查询。

## owner-only MCP

`clawbot-bookkeeping` 已为 `ezbookkeeping` 实现 requester-scoped connection resolver；本节是激活后的安全契约，不代表当前本机 MCP 已开启。只有同时满足以下条件时才返回连接：

1. `messageChannel` 是 `openclaw-weixin`；
2. OpenClaw 提供非空可信 `requesterSenderId`；
3. `openclaw-weixin:<requesterSenderId>` 精确命中本机 `commands.ownerAllowFrom`。

其他发送者、定时任务、心跳、子代理、公开 Gateway 调用及缺少可信发送者元数据的运行均返回 `null`；没有共享后备 URL/header。MCP server 的 `toolFilter.include` 与 bookkeeper 的 `tools.allow` 双重限制有效能力为 `query_transactions`，明确排除 `add_transaction` 和其他原生工具。

### 两份 token 不可混用

| 秘密 | 默认本机路径 | 用途 |
| --- | --- | --- |
| HTTP API token | Node `homedir()` 下的 `.openclaw\secrets\ezbookkeeping-token.txt`（Windows 通常对应 `%USERPROFILE%`） | 定制写入与确定性汇总 |
| MCP token | Node `homedir()` 下独立的 `.openclaw\secrets\ezbookkeeping-mcp-token.txt` | owner-only resolver 构造临时 MCP Bearer header |

MCP token 不进入 OpenClaw 持久配置或模型上下文；token 文件关闭 ACL 继承，仅授予当前 Windows 用户。即便如此，本机其他进程若窃取 MCP token 仍可能调用原生 MCP，这是必须保持 loopback 和本机文件权限的剩余风险。

插件脱敏配置项：

```text
serverBaseUrl = http://127.0.0.1:8888
tokenPath = <LOCAL_API_TOKEN_PATH>
mcpTokenPath = <LOCAL_MCP_TOKEN_PATH>
stateDbPath = <LOCAL_STATE_DB_PATH>
accountName = 日常支出
ledgerDisplayName = 日常账本
```

微信账户绑定和 `commands.ownerAllowFrom` 只写入本机配置，不进入仓库示例的真实值。

### 部署前断言：没有静态 MCP 后备连接

在备份、安装或修改任何本机配置之前，从仓库根目录执行下列只读检查。它只遍历属性名，不输出或序列化配置对象、header 或任何值；`mcp` 或 `servers` 不存在时会安全通过。

```powershell
function Assert-NoStaticEzBookkeepingMcpFallback {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    $rawConfig = $null
    $configObject = $null
    try {
        $rawConfig = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
        $configObject = ConvertFrom-Json -InputObject $rawConfig -ErrorAction Stop
    } catch {
        throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
    } finally {
        $rawConfig = $null
    }

    try {
        if ($null -eq $configObject -or $configObject -isnot [PSCustomObject]) {
            throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
        }

        $mcpProperties = @($configObject.PSObject.Properties | Where-Object { $_.Name -ieq 'mcp' })
        if ($mcpProperties.Count -gt 1) {
            throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
        }

        if ($mcpProperties.Count -eq 1) {
            $mcpObject = $mcpProperties[0].Value
            if ($null -eq $mcpObject -or $mcpObject -isnot [PSCustomObject]) {
                throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
            }

            $serverProperties = @($mcpObject.PSObject.Properties | Where-Object { $_.Name -ieq 'servers' })
            if ($serverProperties.Count -gt 1) {
                throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
            }

            if ($serverProperties.Count -eq 1) {
                $serversObject = $serverProperties[0].Value
                if ($null -eq $serversObject -or $serversObject -isnot [PSCustomObject]) {
                    throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
                }

                $bookkeepingProperties = @($serversObject.PSObject.Properties | Where-Object {
                    $_.Name -ieq 'ezbookkeeping'
                })
                if ($bookkeepingProperties.Count -gt 0) {
                    throw 'Static ezbookkeeping MCP fallback detected; stop deployment and review removal separately.'
                }
            }
        }
    } finally {
        $configObject = $null
    }

    Write-Output 'STATIC_EZBOOKKEEPING_MCP_FALLBACK_ABSENT'
}

$openclawConfigPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.openclaw\openclaw.json'
Assert-NoStaticEzBookkeepingMcpFallback -ConfigPath $openclawConfigPath
```

只有看到 `STATIC_EZBOOKKEEPING_MCP_FALLBACK_ABSENT` 才能继续。若检查失败或发现该属性，停止部署；不要显示其内容，也不要自动删除，必须另开一次有审核的移除操作。此断言、manifest/resolver/allowlist 自动化测试和所有者微信历史查询共同闭合“无静态后备连接”的证据链。

## Ledger 网页、隔离和上线顺序

完整命令、Cloudflare Dashboard 表达式、备份、rollback 与证据矩阵见 `docs/ledger-cloudflare-runbook.md`。交接时必须保持以下顺序：

1. 全仓库自动化、PowerShell 5.1、secret/data scan 通过；在仓库外捕获不覆盖旧证据的 schema-v2 作品集 CNAME/页面基线。
2. 建立 `127.0.0.1:18888` 独立测试实例，在独立数据库完成登录与 create/query/delete；正式账本保持不变。
3. 识别正式任务、进程和唯一用户，创建并验证任务/INI/WAL-safe SQLite 备份，再迁移到 `127.0.0.1:8888`。
4. 用显式且不变的 `SourceRoot/ReleaseRoot/BackupRoot/OpenClawConfigPath` 先 `-ReleaseOnly` 发布 manifest 校验的 `D:\Clawbot\releases\<commit>`，再传入同一 `-ExistingReleasePath` 与 `-SwitchOpenClaw` 切换；失败恢复配置并重启 Gateway。
5. 完成本机 API 与真实 WeChat 回归；只清理由本次验收明确创建的记录。
6. 从 Cloudflare 官方来源安装 cloudflared。需要登录时打开 visible terminal，让用户本机完成授权；不索取或显示凭据。
7. 只读检查现有 Tunnel/DNS/SSL/Rules/Access/槽位；冲突即停，不覆盖未知资源。
8. 建立 Ledger-only 301 redirect、cache bypass、headers、registration/TRACE WAF 和套餐支持的登录限速；HSTS 只在 HTTPS/CRUD 证据通过后补入该 host-only rule。不得设置 zone-wide Always Use HTTPS/HSTS，不得启用 Access。
9. Universal SSL、规则和 origin 通过后，先安装/启动 guarded supervisor，API readback 确认 named Tunnel connected；然后 DNS cutover last，只新增 `ledger` 到专用 Tunnel。
10. 执行公网、task-cycle/fail-closed、分两次运行的真实 Windows 重启、WeChat 与 apex/`www` 作品集回归。任一行缺证据就不能报告完成。

Cloudflare Free plan 的 path-only rate limit 只有在部署时对 apex 和 `www` 的 `/api/authorize.json` 同时完成 GET/POST 碰撞探测，且 15 分钟内的脱敏 Cloudflare API readback 证明 `http_ratelimit` 规则数为 0 后才能启用。不得用人工布尔参数自证槽位；任何条件未知就跳过并记录，不能影响作品集。

Tunnel supervisor 从不停止 ezBookkeeping。只有在连续检查都确认精确 `8888` listener、PID/创建时间/程序路径、显式 production config、health 和 ezBookkeeping 登录页后，它才启动自己的 cloudflared child；状态退化时只通过已绑定原进程的 containment handle 停止该 child。启动前必须核对独立官方 checksum、Authenticode、`TUNNEL_*`/`NO_AUTOUPDATE` 环境覆盖、专用 runtime/log marker 与精确 config/credential；PID 复用、未知端口 owner 或未知 cloudflared 永不被结束或接管。

Tunnel 安装必须显式传入 `-CredentialPath`、`-TunnelConfigPath` 和与本机文件独立核对过的 `-ExpectedCloudflaredSha256`。Tunnel task 已安装并启动后，再运行 `test-ledger-local.ps1 -ReleasePath <EXACT_RELEASE> -CredentialPath <LOCAL_JSON> -TunnelConfigPath <LOCAL_YML> -ExpectedCloudflaredSha256 <APPROVED_SHA256>`。真实重启则必须先运行 `test-ledger-restart.ps1 -Phase CapturePreReboot -RebootEvidencePath <EXTERNAL_NEW_JSON>`，重启 Windows 后再用同一证据运行 `-Phase VerifyPostReboot`，并证明 `LastBootUpTime` 已变更。

## Windows 安装

### 0. 安装并登录官方 Codex harness

```powershell
openclaw plugins install codex --accept-capabilities
openclaw plugins enable codex --accept-capabilities
openclaw models auth login --provider openai --agent bookkeeper
```

安装器会选择与当前 OpenClaw 兼容的最新 `@openclaw/codex` 版本。专用代理配置必须使用规范模型名 `openai/gpt-5.6-sol`，并在该模型条目上设置 `agentRuntime.id: codex`；不要添加 Qwen 或其他 fallback。OAuth 凭据只保存在本机 OpenClaw 凭据存储中，不进入仓库。

同时设置 Codex 动态工具直接加载：

```powershell
openclaw config set plugins.entries.codex.config.codexDynamicToolsLoading direct
```

bookkeeper 的 allowlist 只有五个账本工具，因此这里不依赖工具搜索。Codex Code Mode 仍可在 `exec` 中调用已经直接加载的 `tools.<账本工具>`；不得查询 `ALL_TOOLS` 或搜索工具目录。包装返回字符串时原样输出完整字符串。工具返回文本是最终账本事实；模型不得自行重建回执。设置后必须重启 Gateway。

默认安装目录是 `D:\Clawbot\ezbookkeeping`，实际配置文件位于嵌套目录 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。

### 1. 安装或核验可恢复计划任务

先预演：

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
```

再实际安装：

```powershell
.\scripts\install-ezbookkeeping-task.ps1
```

脚本只接受不存在的任务，或动作已经完全匹配的根任务 `Clawbot ezBookkeeping`；不使用 blind `-Force` 覆盖未知任务。正式动作直接执行规范化的 `ezbookkeeping.exe --conf-path "D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini" server run`，工作目录固定为安装目录。生产迁移前，旧的直接 `server run` 动作只能由 `migrate-ledger-production.ps1` 在完成任务定义备份后转换一次。

### 2. 启用 MCP 并生成独立 token

先预演；此步骤不得修改任何状态，也不会询问密码：

```powershell
.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
```

再在用户可见的 PowerShell 中实际执行，由用户在安全提示中输入 ezBookkeeping 密码：

```powershell
.\scripts\configure-ezbookkeeping-mcp.ps1
```

脚本按以下顺序工作：

1. 读取并解析 `[mcp]`，只设置 `enable_mcp = true` 和 `mcp_allowed_remote_ips = 127.0.0.1`；缺失、重复或出现在错误 section 时失败关闭。
2. 使用不覆盖的原子复制创建唯一 `*.before-mcp-<timestamp>` 备份，再以原子替换更新原配置。
3. 要求根目录下恰好一个同名计划任务，并核对可执行文件、显式 `--conf-path`、完整参数和工作目录。
4. 停止前再次核对 PID、创建时间、可执行路径、完整命令行和端口 owner；只控制已核验的任务/进程。
5. 等待 `http://127.0.0.1:8888/healthz.json` 返回 `success=true`。
6. 安全读取密码，以现有 API token 请求独立 MCP token；去除首尾空白并拒绝换行后，写入 owner-only 文件。

任何一步失败都会尝试把原配置和先前服务状态恢复。若自动回滚也失败，错误会保留具体备份路径供手工恢复。脚本不输出密码、API token、MCP token、请求体或 Authorization header。

## 运行检查

先确认 ezBookkeeping 健康，再判断 Gateway 和 MCP 是否成功：

```powershell
Invoke-RestMethod http://127.0.0.1:8888/healthz.json
openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
openclaw plugins inspect codex
openclaw models status --agent bookkeeper --json
```

验收条件：

- 健康端点返回 `success=true`；
- Gateway 只监听 loopback，微信通道正常；
- 插件加载成功；
- Codex 插件状态为 loaded，`bookkeeper` 的 `openai/gpt-5.6-sol` 条目显式显示 `agentRuntime.id: codex`；
- Codex 插件的 `codexDynamicToolsLoading` 为 `direct`，专用代理通过 Code Mode 直接调用 allowlist 中的账本工具，不查询 `ALL_TOOLS` 或搜索工具目录；
- 自动化测试确认 manifest、requester-scoped resolver 和代理 allowlist 允许 `query_transactions`，且源码和测试明确排除 `add_transaction`；
- 所有者从微信发起的历史查询实际返回账本记录，证明 `query_transactions` 在可信发送者上下文中可用。

动态 MCP 由插件 manifest 和 requester-scoped resolver 声明，故意不配置顶层 `mcp.servers` 静态连接。第一版不使用 operator CLI 证明该动态连接；部署前属性名断言证明没有静态 `ezbookkeeping` 后备项，插件加载结果和自动化策略测试证明动态声明与最小工具目录，所有者微信历史查询证明可信上下文中的实际连接。

如 ezBookkeeping 不健康，先以只读方式核验任务动作和端口 owner。安装脚本不会替换漂移任务；不要由模型启动服务，也不要直接重启未经验证的同名任务：

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1
$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -eq 'Clawbot ezBookkeeping' -and $_.TaskPath -eq '\'
})
if ($tasks.Count -ne 1) { throw 'Expected exactly one root Clawbot ezBookkeeping task.' }
Start-ScheduledTask -InputObject $tasks[0] -ErrorAction Stop
Invoke-RestMethod http://127.0.0.1:8888/healthz.json
```

重新运行安装脚本只会创建缺失任务或确认既有动作完全一致；任何漂移都失败关闭。不要删除或覆盖冲突任务来绕过检查。

若配置 MCP 失败且自动回滚失败，使用错误中记录的 `before-mcp` 备份恢复 `conf\ezbookkeeping.ini`，再重启同一个已核验任务。不要停止其他路径或名称碰巧相同的进程。

## 仓库验证

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs
```

账本插件当前完整测试必须零失败，stable-ID 插件 build 与 3 项测试必须全部通过；覆盖项还包括 runtime 隔离、release 完整性、Tunnel fail-closed 与公网规则范围。不要只依赖数量，任何失败都必须处理。

仓库秘密扫描：

```powershell
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.worktrees/**' 'Bearer\s+[A-Za-z0-9._-]{20,}|openclaw-weixin:[A-Za-z0-9_-]{8,}' .
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.worktrees/**' '(?i)password\s*[:=]\s*["''][^<][^"'']{7,}["'']' .
```

`.worktrees` 仅因它是同一仓库的嵌套副本而排除，测试和示例目录不能排除。扫描可能命中固定的合成 fixture；必须人工检查每一条结果及其上下文，确认它不是现实 token、发送者身份或字面密码。任何无法解释的匹配都按真实泄露处理，不能为了得到“零命中”而盲目忽略 fixture/example。

## 微信验收

不要批量导入示例。由所有者按顺序发送少量真实请求并直接核对账本：

1. 一条新的实际消费，例如 `支出7.2 午饭`：应返回六行回执，时间为可信发送时间，账本只新增一笔。
2. 一条带明确过去时间的实际消费，例如 `记账昨天晚上6点钟，晚餐10.5`：回执和账本时间都应为昨天 `18:00`，只新增一笔。
3. `这个月我花了多少钱`：应返回精确 A 型汇总，不写入。
4. `这个月吃饭花了多少`：应按正式分类汇总，不写入。
5. MCP 激活后发 `最近三笔支出是什么`：应调用只读 MCP，默认只列实际记录。
6. MCP 激活后发 `上个月在NTUC买过什么`：应只依据实际查询结果回答。
7. 对原消息执行平台级重放：不得新增第二笔。

微信只应看到最终结果。不得出现思考过程、工具名、JSON、参数校验、候选分类、底层错误或重试过程。

仓库中的插件或 `openclaw-workspace/AGENTS.md` 部署到本机运行目录后必须重启 OpenClaw Gateway，再运行 `openclaw gateway status` 与 `openclaw channels status --probe`；未重启时不能把仓库测试通过当作微信端已经加载新行为。

## 故障文案

- 汇总或历史读取失败：`账本暂时连不上，本次没有读取任何数据，请稍后再试。`
- 写入在提交前失败：`账本暂时连不上，本次没有写入任何数据，请稍后再试。`
- 写入请求已提交但结果不确定：`记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。`
- 期间无支出：使用对应期间加 `还没有支出记录～`。
- 信息不足：自然追问唯一缺失信息，不再统一回复“记账失败，请重新发送一条新消息”。

## 交接文件

| 文件 | 用途 |
| --- | --- |
| `README.md` | 发布架构、行为与快速验证 |
| `WINDOWS-HANDOFF.md` | 本文件；部署、运行、恢复与微信验收 |
| `docs/bookkeeping-deployment-brief.md` | 方案与安全权衡摘要 |
| `docs/expense-categories.md` | 11/45 分类可读表 |
| `openclaw-plugins/clawbot-bookkeeping/categories.mjs` | 运行时权威分类契约 `CATEGORY_DEFINITIONS` |
| `config/expense-categories.json` | 脱敏的分类导入与部署快照 |
| `config/*.example.json` | 脱敏 OpenClaw 配置模板 |
| `config/ezbookkeeping-*.example.ini` | 正式/测试安全配置合同 |
| `config/cloudflared-ledger.example.yml` | 精确 Ledger ingress 示例 |
| `config/cloudflare-ledger-rules.example.json` | Ledger-only Cloudflare 规则清单 |
| `scripts/install-ledger-test-instance.ps1` | `18888` 隔离测试实例安装 |
| `scripts/migrate-ledger-production.ps1` | 经备份验证的 `8888` 正式迁移 |
| `scripts/publish-openclaw-release.ps1` | immutable release 发布与 OpenClaw 切换/回滚 |
| `scripts/install-ledger-tunnel-task.ps1` | fail-closed Tunnel supervisor task 安装 |
| `scripts/test-ledger-local.ps1` | 本机隔离与安全检查 |
| `scripts/test-ledger-public.ps1` | 公网、token 边界与作品集检查 |
| `scripts/test-ledger-restart.ps1` | 精确任务重启和 fail-closed 检查 |
| `scripts/configure-ezbookkeeping-mcp.ps1` | MCP 配置、token 生成和回滚 |
| `docs/ledger-cloudflare-runbook.md` | Ledger 上线、Cloudflare、验收与恢复主手册 |
| `openclaw-plugins/clawbot-bookkeeping/` | 写入、汇总、MCP resolver 与测试 |
| `openclaw-plugins/openclaw-weixin-stable-id/` | 稳定消息 ID 和发送者元数据 |

本仓库不是完整运行状态备份。恢复另一台主机时，程序、账本数据库、微信登录和所有秘密必须通过单独的安全流程恢复。

## 网页与后续边界

家庭网页固定复用 ezBookkeeping UI，通过专用 Cloudflare Tunnel 发布 `ledger.66ccff-labs.com`。Cloudflare 只承担 TLS、流量规则和传输；SQLite、API/MCP token 与 OpenClaw 仍只在 Windows。不得增加 Vercel/云数据库同步、Cloudflare Access 双重登录、共享账户或开放 origin 端口，除非获得新的明确设计批准。
