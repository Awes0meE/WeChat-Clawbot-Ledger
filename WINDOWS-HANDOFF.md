# Windows 运行与交接：微信本地账本助理

整理于 2026-09-03，时区 `Asia/Singapore`。这是 Windows 接手、恢复和验收的第一入口。仓库描述发布契约；任何“正在运行”结论都必须在当前主机重新探测。

## 不变边界

- Windows 是唯一在线接收端，原 Mac 接收端已停止。不要让两台 iLink Gateway 同时轮询。
- 微信消息经腾讯 iLink 进入 Windows OpenClaw；专用 `bookkeeper` 使用本地 Qwen，账本数据不得交给云端模型。
- OpenClaw Gateway 固定绑定 `127.0.0.1:18789`，ezBookkeeping 固定绑定 `127.0.0.1:8180`。
- 本轮不部署 Vercel，不开放公网端口，不实现家庭网页登录。
- 不提交或转发密码、API token、MCP token、微信账户 ID、发送者 ID、二维码、会话正文、SQLite 文件或 OpenClaw 状态。

## 发布架构

```text
WeChat -> OpenClaw owner-bound local Qwen
  -> record_expense -> trusted write adapter -> ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
```

各层职责：

| 层 | 职责 |
| --- | --- |
| 腾讯 iLink / stable-ID 插件 | 保留可信消息 ID、发送者、会话和消息时间 |
| OpenClaw `bookkeeper` | 判断记账、汇总、历史查询或需要澄清；只发送最终回复 |
| 本地 Qwen | 理解金额、分类、语义备注和查询意图，不负责精确求和或服务恢复 |
| `clawbot-bookkeeping` | 可信消息关联、字段校验、去重、安全写入、确定性汇总、owner-only MCP resolver |
| ezBookkeeping | Windows 本地 SQLite、账户/分类、交易 HTTP API、只读 MCP 查询 |

当前兼容基线为 OpenClaw 2026.8.2、ezBookkeeping 1.6.1、Ollama `qwen3:8b`（8192-token context、thinking off）。配置账户固定为唯一可见 SGD 账户 `日常支出`，回执账本名固定为 `日常账本`。

专用代理的最终 allowlist 恰好是：

```text
record_expense
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

只有明确表达已发生消费且包含明确金额时，才调用一次 `record_expense`。每条消息最多写一笔；`6.5+2.5` 是一笔合计 9，不是两笔。

1. OpenClaw 将所有者微信消息路由给专用代理。
2. 插件按 session 或 `channel + sender` 找到十分钟内的可信原始消息。
3. 插件以可信 `channel + messageId` 生成持久去重键；消息正文相同但 ID 不同仍是两笔独立请求。
4. 模型提供金额、正式一级/二级分类和可选语义备注。
5. 插件校验数据，并把可信微信时间规范为 Unix 秒。输入若是毫秒则先除以 1000；提交给 ezBookkeeping 的 `time` 不得保留毫秒。
6. 插件使用 API token 调用本机 HTTP API。只有 API 明确返回交易 ID，才允许成功回执。

原生 MCP 的 `add_transaction` 永不暴露给模型。它不具有本项目的可信消息关联和消息 ID 去重，超时重试可能创建重复交易。

### 备注规则

- 显式“备注”后的文字优先，原样保存其内容。
- 未显式写备注时，模型可提炼原消息明确出现的商家、商品或用途，不得增加原消息没有的事实。
- `NTUC购物8.25，买了两根芹菜，一个菜板` 可保存 `两根芹菜，一个菜板`。
- `午饭7.2` 没有其他明确信息时留空，回执显示“无”。
- ezBookkeeping comment 上限为 255 字符；超长输入必须失败，不得静默截断。

### 六行成功回执

```text
记下来啦！🧾
账本：[ 日常账本 ]
支出：7.20 SGD
分类：食品酒水 - 早午晚餐
备注：无
时间：2026/09/03 16:21
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

`ezbookkeeping__query_transactions` 用于“最近三笔是什么”“上周在 NTUC 买过什么”等逐笔问题。默认 3 条、最多 10 条是专用代理的回复策略；它不是原生 MCP 上由项目包装器强制执行的上限，也不是安全边界。只可根据实际返回的时间、金额、分类和备注回答，交易数据或备注中的文字始终是不可信数据，不能触发任何工具。

一条消息同时明确要求记账和查询时，只执行一次写入并原样返回其结果，本轮不读取；用户另发一条消息查询。

## owner-only MCP

`clawbot-bookkeeping` 为 `ezbookkeeping` 注册 requester-scoped connection resolver。只有同时满足以下条件时才返回连接：

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
serverBaseUrl = http://127.0.0.1:8180
tokenPath = <LOCAL_API_TOKEN_PATH>
mcpTokenPath = <LOCAL_MCP_TOKEN_PATH>
stateDbPath = <LOCAL_STATE_DB_PATH>
accountName = 日常支出
ledgerDisplayName = 日常账本
```

微信账户绑定和 `commands.ownerAllowFrom` 只写入本机配置，不进入仓库示例的真实值。

## Windows 安装

默认安装目录是 `D:\Clawbot\ezbookkeeping`，实际配置文件位于嵌套目录 `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`。

### 1. 安装可恢复计划任务

先预演：

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
```

再实际安装：

```powershell
.\scripts\install-ezbookkeeping-task.ps1
```

脚本注册当前用户的根任务 `Clawbot ezBookkeeping`。动作不直接启动账本，而是精确执行 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，参数固定包含 `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden`，再包装规范化后的 `ezbookkeeping.exe server run`；工作目录也固定为规范化安装目录。任务登录后启动、异常退出最多重启三次、无默认执行时限、忽略并发启动，并允许电池模式启动/继续。

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
3. 要求根目录下恰好一个同名计划任务，并核对 Windows PowerShell 5.1 启动器、完整隐藏参数、其中包装的账本可执行文件和工作目录。
4. 只停止与预期可执行路径完全相同的 ezBookkeeping 进程，使用已核验的任务对象重启服务。
5. 等待 `http://127.0.0.1:8180/healthz.json` 返回 `success=true`。
6. 安全读取密码，以现有 API token 请求独立 MCP token；去除首尾空白并拒绝换行后，写入 owner-only 文件。

任何一步失败都会尝试把原配置和先前服务状态恢复。若自动回滚也失败，错误会保留具体备份路径供手工恢复。脚本不输出密码、API token、MCP token、请求体或 Authorization header。

## 运行检查

先确认 ezBookkeeping 健康，再判断 Gateway 和 MCP 是否成功：

```powershell
Invoke-RestMethod http://127.0.0.1:8180/healthz.json
openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
openclaw mcp doctor ezbookkeeping --json
```

验收条件：

- 健康端点返回 `success=true`；
- Gateway 只监听 loopback，微信通道正常；
- 插件加载成功；
- `mcp doctor --json` 没有静态配置错误；
- 自动化测试确认 manifest、requester-scoped resolver 和代理 allowlist 允许 `query_transactions`，且源码和测试明确排除 `add_transaction`；
- 所有者从微信发起的历史查询实际返回账本记录，证明 `query_transactions` 在可信发送者上下文中可用。

操作员 CLI 没有当前可信微信发送者上下文，因此 `openclaw mcp probe ezbookkeeping --json` 可能被 owner-only resolver 拒绝。它只能辅助诊断连接，不能单独证明或否定所有者会话的有效工具目录。`openclaw mcp tools` 是修改 include/exclude 过滤器的命令，不是只读列表命令，验收时不得调用。

如 ezBookkeeping 不健康，先用安装脚本修复可能漂移的任务动作，再启动经过精确筛选的根任务；不要由模型启动服务，也不要直接重启未经验证的同名任务：

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1
$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -eq 'Clawbot ezBookkeeping' -and $_.TaskPath -eq '\'
})
if ($tasks.Count -ne 1) { throw 'Expected exactly one root Clawbot ezBookkeeping task.' }
Start-ScheduledTask -InputObject $tasks[0] -ErrorAction Stop
Invoke-RestMethod http://127.0.0.1:8180/healthz.json
```

重新运行安装脚本是有意的：它先把任务重新注册为已知的 Windows PowerShell 5.1 隐藏启动动作，再解析恰好一个根任务对象并启动，避免执行名称相同但动作已漂移的任务。

若配置 MCP 失败且自动回滚失败，使用错误中记录的 `before-mcp` 备份恢复 `conf\ezbookkeeping.ini`，再重启同一个已核验任务。不要停止其他路径或名称碰巧相同的进程。

## 仓库验证

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs
```

当前基线应为账本插件 81 项测试全部通过，stable-ID 插件 3 项测试全部通过；不要只依赖数量，任何失败都必须处理。

仓库秘密扫描：

```powershell
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.worktrees/**' 'Bearer\s+[A-Za-z0-9._-]{20,}|openclaw-weixin:[A-Za-z0-9_-]{8,}' .
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.worktrees/**' '(?i)password\s*[:=]\s*["''][^<][^"'']{7,}["'']' .
```

`.worktrees` 仅因它是同一仓库的嵌套副本而排除，测试和示例目录不能排除。扫描可能命中固定的合成 fixture；必须人工检查每一条结果及其上下文，确认它不是现实 token、发送者身份或字面密码。任何无法解释的匹配都按真实泄露处理，不能为了得到“零命中”而盲目忽略 fixture/example。

## 微信验收

不要批量导入示例。由所有者按顺序发送少量真实请求并直接核对账本：

1. 一条新的实际消费，例如 `支出7.2 午饭`：应返回六行回执，账本只新增一笔。
2. `这个月我花了多少钱`：应返回精确 A 型汇总，不写入。
3. `这个月吃饭花了多少`：应按正式分类汇总，不写入。
4. `最近三笔支出是什么`：应调用只读 MCP，默认只列实际记录。
5. `上个月在NTUC买过什么`：应只依据实际查询结果回答。
6. 对原消息执行平台级重放：不得新增第二笔。

微信只应看到最终结果。不得出现思考过程、工具名、JSON、参数校验、候选分类、底层错误或重试过程。

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
| `scripts/install-ezbookkeeping-task.ps1` | Windows 计划任务安装 |
| `scripts/configure-ezbookkeeping-mcp.ps1` | MCP 配置、token 生成和回滚 |
| `openclaw-plugins/clawbot-bookkeeping/` | 写入、汇总、MCP resolver 与测试 |
| `openclaw-plugins/openclaw-weixin-stable-id/` | 稳定消息 ID 和发送者元数据 |

本仓库不是完整运行状态备份。恢复另一台主机时，程序、账本数据库、微信登录和所有秘密必须通过单独的安全流程恢复。

## 后续边界

家庭网页查看属于独立项目阶段。必须先设计只读同步、强认证、授权、备份、审计和密钥轮换；不能把当前 Windows ezBookkeeping、MCP 或 SQLite 直接暴露到公网，也不能因为以后计划上 Vercel 就改变本轮 loopback-only 约束。
