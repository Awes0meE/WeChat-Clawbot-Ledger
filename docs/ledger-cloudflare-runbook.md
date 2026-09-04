# Ledger Cloudflare Tunnel 运维手册

本文说明如何把现有 ezBookkeeping 通过 `https://ledger.66ccff-labs.com` 安全发布，同时保持 `66ccff-labs.com` 和 `www.66ccff-labs.com` 的作品集不变。它是实施手册，不是凭据存放处；任何真实账户、密码、token、Tunnel UUID、Cloudflare 身份、微信身份、SQLite、交易正文、响应正文和运行日志都必须留在 Git 与仓库之外。

## 固定合同

| 用途 | 固定值 |
| --- | --- |
| 正式网页与 API | `https://ledger.66ccff-labs.com` |
| 正式 ezBookkeeping | `127.0.0.1:8888` |
| 隔离测试 ezBookkeeping | `127.0.0.1:18888` |
| OpenClaw Gateway | `127.0.0.1:18789` |
| 正式 ezBookkeeping 任务 | `\Clawbot ezBookkeeping` |
| Ledger Tunnel 任务 | `\Clawbot Ledger Tunnel` |

正式 OpenClaw 只加载校验过的 `D:\Clawbot\releases` 版本，不加载当前 Git 工作区。Cloudflare Tunnel 的 origin 只能是 `http://127.0.0.1:8888`。不得监听 `0.0.0.0`、LAN 地址，不开放路由器或 Windows 防火墙入站端口。

只保留 ezBookkeeping 一次登录。不得为该 hostname 启用 Cloudflare Access。未登录访问者看见 ezBookkeeping 登录页是已接受的剩余风险；实际防线是应用认证、原生可选 2FA、服务端关闭注册与找回密码、登录限速以及持续更新。

## 本机目录边界

以下是推荐的真实运行目录；创建时必须关闭 ACL 继承，只授权运行账户、`SYSTEM` 和确有需要的 Administrators。不要把它们放在仓库或 OneDrive 中。

```text
D:\Clawbot\ezbookkeeping\                 正式程序、配置和 SQLite
D:\Clawbot\ezbookkeeping-test\            隔离测试程序和独立 SQLite
D:\Clawbot\releases\                       不可变 OpenClaw releases
D:\Clawbot\cloudflared\                    cloudflared、真实 config 与 Tunnel JSON
D:\Clawbot\cloudflared\runtime\            已校验 supervisor/common 与专用 marker
D:\Clawbot\cloudflared\logs\               唯一 supervisor log 与专用 marker
D:\Clawbot\backups\                        配置、任务定义和一致 SQLite 备份
D:\Clawbot\deployment-evidence\            仅脱敏状态、时间和哈希
```

真实 Tunnel 配置、Tunnel JSON、Cloudflare 登录证书和所有本机证据必须位于 outside the repository。仓库内只保留 `config/*.example.*` 示例。

## 上线前门禁

1. 当前分支必须包含设计基准 `c59da14`，工作分支为 `feat/secure-ledger-tunnel`。
2. 全部 Node 测试、stable-ID build/test、PowerShell 5.1 语法测试和 `git diff --check` 通过。
3. 仓库扫描没有真实 token、身份、SQLite、日志或交易内容。
4. `8888` 和 `18888` 尚未被未知程序占用；绝不自动终止未知进程。
5. 当前正式任务、进程、配置、健康和唯一启用用户均可被严格识别。
6. `%USERPROFILE%\.openclaw\openclaw.json` 中不存在静态 ezBookkeeping MCP token 后备项。
7. 所有本机正式修改前，配置、任务定义和数据库一致快照已经创建并验证。
8. 作品集 DNS、HTTP redirect、HTTPS、响应头和页面指纹基线已保存到仓库外。
9. 当前 Cloudflare 套餐、规则能力、已有 Tunnel/DNS/Rules/Access 和可用规则槽位均以部署时实际界面为准，不凭文档或记忆推断。

任何门禁失败都停止。不要通过覆盖同名任务、删除未知账户、停止未知进程或放宽网络边界来继续。

## 1. 自动化验证

从仓库根目录运行：

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

Set-Location ..\..\
git diff --check
```

对所有 `scripts\*.ps1` 使用 Windows PowerShell 5.1 parser 检查。对安装、迁移、发布和重启脚本先执行 `-WhatIf`；预演不得读 token、发 HTTP、控制任务、启动进程或写文件。

秘密扫描必须排除 `.git`、依赖和已知 worktree，但不能排除 `test`、`config`、`scripts` 或文档。匹配项由人工看上下文，不能为了零匹配扩大 ignore。

## 2. 捕获部署前作品集基线

先创建仓库外证据目录，再运行只读脚本。路径只是示例；不得把输出写回仓库。

```powershell
.\scripts\test-ledger-public.ps1 `
  -CapturePortfolioBaseline `
  -PortfolioBaselinePath 'D:\Clawbot\deployment-evidence\portfolio-before-v2.json'
```

捕获模式在保存作品集后立即返回，不要求 Ledger DNS 已存在。schema-v2 基线保存 `www` 的公开规范 CNAME target；Cloudflare 会扁平化 apex CNAME，因此 apex 只保存稳定的 `flattened-apex` 形态，并要求至少存在一条 A/AAAA 解析结果，但不保存会轮换的 CDN 地址。Cloudflare API 的部署前后 readback 另行证明 apex/`www` 的权威记录内容未变。基线另含状态、重定向位置、选定响应头、正文长度和 SHA-256，不含响应正文。如已有 schema-v1 证据，保留原文件并创建上述新 v2 文件；捕获脚本遇到已存在目标会拒绝覆盖。

另行记录以下脱敏事实：当前 branch/HEAD、两个计划任务的名称与动作摘要、`8180/8888/18888` 监听状态和所有者摘要、ezBookkeeping health 布尔值、OpenClaw Gateway/channel/plugin health、插件和 workspace 是否位于 Git checkout，以及 `ledger` 当前是否 NXDOMAIN。不得记录配置值、命令行中的秘密或页面正文。

## 3. 建立 `18888` 测试实例

先预演 `scripts/install-ledger-test-instance.ps1`，再执行真实安装。安装器必须：

- 只白名单复制程序资产，不复制正式 `conf`、`data`、`storage` 或日志；
- 创建独立配置、随机 secret、数据库、token 和任务；
- 固定 `generator_type = internal`，并使用与正式实例 `0` 不同的 UUID `server_id = 1`；
- 显式保留 v1.6.1 启动必需的 `in_memory` duplicate checker、OAuth2 identifier、Amap verification method 与汇率源，即使相应可选功能当前关闭；
- 固定 `127.0.0.1:18888`，禁止回退到 `8888`；
- 拒绝缺少受控 marker 的已有目录或同名任务；
- 在安全的 visible terminal 中使用 `Read-Host -AsSecureString` 创建测试账户，不把密码放进参数或进程列表；
- 初始化失败时重新关闭注册、停止测试任务且不写 ready marker。

只在测试数据库上完成登录、网页 create/query/delete、API create/query/delete、服务端注册关闭和 token 边界验证。证明测试和正式数据库的规范路径及 SHA-256 不同，并确认正式数据库哈希、账户数和聚合不变。

## 4. 迁移正式 ezBookkeeping 到 `8888`

先运行 `scripts/migrate-ledger-production.ps1 -WhatIf`。真实迁移只有在脚本再次识别旧任务、`8180` 监听 PID、创建时间、可执行文件、工作目录和完整命令行后才能进行。

真实迁移必须依次完成：

1. 拒绝 Process/User/Machine 范围的 `EBK_CONF_PATH`、`EBK_*` 或 `EBKCFP_*` 覆盖。
2. 备份并校验原任务定义和 INI。
3. 使用 Node `node:sqlite` backup 创建 WAL-safe 一致快照；对快照验证 SQLite header、`PRAGMA quick_check` 和恰好一个未删除且启用用户。
4. 原子修改 INI，只设置已批准字段：正式 loopback/`8888`、正式 domain/root URL、注册和找回密码关闭、登录失败限制、API/MCP/trusted proxy loopback；保留当前 `enable_mcp` 选择。
5. 把已识别旧任务改为显式 `--conf-path` 的精确动作；不覆盖任何不匹配任务。
6. 验证 `8180` 已无监听，`8888` 恰有一个预期监听者、health 成功且登录页指纹正确。

发生失败时恢复 INI、任务定义和原运行状态。数据库备份只用于灾难恢复，永不由脚本自动覆盖正式数据库；正式数据库可能已有新交易时，恢复必须再次取得用户明确批准。

## 5. 发布并切换正式 OpenClaw release

先确保 Git 源在发布前后都干净且 HEAD 不变。`scripts/publish-openclaw-release.ps1` 使用固定 allowlist、lockfile 和禁用 lifecycle scripts 的安装生成 sibling staging；校验所有依赖、manifest、相对路径、长度、SHA-256 和 reparse point 后才原子发布到 `D:\Clawbot\releases`。既有 release 不可覆盖。

发布与切换是两次独立执行；后一次必须显式传入前一次创建的同一 commit release，且两次的 source/release/backup/config 根必须完全相同：

```powershell
$repo = (Resolve-Path -LiteralPath '.').Path
$releaseRoot = 'D:\Clawbot\releases'
$releaseBackupRoot = "$env:USERPROFILE\.openclaw\backups"
$openClawConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json"
$releasePath = Join-Path $releaseRoot ((git -C $repo rev-parse HEAD).Trim())

$releaseArguments = @{
  SourceRoot = $repo
  ReleaseRoot = $releaseRoot
  BackupRoot = $releaseBackupRoot
  OpenClawConfigPath = $openClawConfigPath
}
.\scripts\publish-openclaw-release.ps1 @releaseArguments -ReleaseOnly -WhatIf
.\scripts\publish-openclaw-release.ps1 @releaseArguments -ReleaseOnly
# 只有上一行返回 OPENCLAW_RELEASE_PUBLISHED 且 $releasePath 完整校验通过后才继续
.\scripts\publish-openclaw-release.ps1 @releaseArguments -ExistingReleasePath $releasePath -SwitchOpenClaw -WhatIf
.\scripts\publish-openclaw-release.ps1 @releaseArguments -ExistingReleasePath $releasePath -SwitchOpenClaw
```

切换前先备份并验证 OpenClaw 配置。临时 patch 位于仓库外且只含：完整替换后的 plugin path 数组、bookkeeper workspace 和 `http://127.0.0.1:8888`。它不得序列化 token、owner、channel 或其他配置。先 `openclaw config patch --dry-run --file`，再应用真实 patch。

只重启 OpenClaw Gateway；不得停止 ezBookkeeping 或 Tunnel。验证：

- Gateway 与 WeChat channel probe 正常；
- bookkeeping 与 stable-ID plugin 均从 release 加载；
- bookkeeper workspace 位于 release；
- 仍固定官方 Codex harness、`gpt-5.6-sol` 与原 owner allowlist；
- Git checkout 不出现在任何正式加载路径中。

任一后置检查失败，恢复经验证的 OpenClaw 配置备份并重启 Gateway 回到原状态。

## 6. 本机业务回归

只在 release 已切换且 Tunnel task 已安装/启动后运行 `scripts/test-ledger-local.ps1`；显式传入 `-ReleasePath`、`-CredentialPath`、`-TunnelConfigPath` 以及从独立官方 checksum 校验后得到的 `-ExpectedCloudflaredSha256`。脚本只输出固定 pass/fail 码。它验证：

- 正式 `127.0.0.1:8888` 与测试 `127.0.0.1:18888` 的唯一所有者、显式配置和数据库隔离；
- health 与 ezBookkeeping 页面指纹；
- 正式注册、无效找回密码关闭；
- API token、MCP 与 trusted proxy 仅 loopback；
- OpenClaw release manifest、正式任务和 Tunnel 子进程/任务身份。

随后用一个明确的、一次性的正式验收记录执行本地 API create/query/delete。脚本不得保存或打印内容；删除后必须证明初始账户/聚合不变量恢复。

由所有者从真实可信 WeChat channel 发一条新的验收记账消息。验证恰好一个 API 写入和一个 API 成功后的权威回复；重复投递同一可信 message ID 不得创建第二条；历史查询必须正确。最后只删除已知验收记录，不能模糊清理或删除未知交易。

## 7. 安装并登录 cloudflared

仅从 Cloudflare 官方发布渠道安装，记录版本和 Authenticode/发布校验结果。把固定版本 `cloudflared.exe` 放入受控本机目录。

如需授权，打开 visible terminal 并在其中运行：

```powershell
cloudflared tunnel login
```

用户只在本机浏览器完成 Cloudflare 登录和域名授权。不要索取、粘贴或回显凭据；不要把证书、Tunnel JSON 或 UUID 发到聊天。授权后先只读检查现有 Tunnel、DNS、SSL、Redirect、Worker/Page route、Cache、Transform、WAF、Rate Limit、Access 和规则槽位。发现同名或同 hostname 冲突时停止，不替换未知资源。

创建或识别专用命名 Tunnel。根据 `config/cloudflared-ledger.example.yml` 在受控目录生成真实配置：

```yaml
tunnel: <LOCAL_TUNNEL_UUID>
credentials-file: '<ABSOLUTE_PROTECTED_LOCAL_JSON_PATH>'
no-autoupdate: true
ingress:
  - hostname: ledger.66ccff-labs.com
    service: http://127.0.0.1:8888
  - service: http_status:404
```

每次安装和启动前都要拒绝 Process/User/Machine 中的任何 `TUNNEL_*` 或 `NO_AUTOUPDATE` 覆盖，且核对 `cloudflared.exe` 的已批准 SHA-256 和有效 `Cloudflare, Inc.` Authenticode 签名。配置和 credential 必须是同一专用本地固定盘根下的绝对路径，不得经过 reparse point。`runtime` 与 `logs` 目录必须带有安装器创建的正确 marker；未标记目录或已有未知 log 一律保留并拒绝接管。

始终把本地 config 显式传给 ingress 检查，不依赖当前目录或默认配置：

```powershell
& 'D:\Clawbot\cloudflared\cloudflared.exe' tunnel --config 'D:\Clawbot\cloudflared\ledger.yml' ingress validate
& 'D:\Clawbot\cloudflared\cloudflared.exe' tunnel --config 'D:\Clawbot\cloudflared\ledger.yml' ingress rule 'https://ledger.66ccff-labs.com/ledger-ingress-probe?probe=1'
$approvedCloudflaredSha256 = '<64_HEX_FROM_SEPARATELY_VERIFIED_OFFICIAL_RELEASE_CHECKSUM>'
$actualCloudflaredSha256 = (Get-FileHash -LiteralPath 'D:\Clawbot\cloudflared\cloudflared.exe' -Algorithm SHA256).Hash
if ($actualCloudflaredSha256 -cne $approvedCloudflaredSha256) { throw 'Downloaded cloudflared does not match the separately approved checksum.' }
.\scripts\install-ledger-tunnel-task.ps1 `
  -CredentialPath 'D:\Clawbot\cloudflared\<LOCAL_TUNNEL_UUID>.json' `
  -ExpectedCloudflaredSha256 $approvedCloudflaredSha256 `
  -StartAfterInstall `
  -WhatIf
```

预演结果精确无误后，用同样参数去掉 `-WhatIf` 执行。安装器在最后写入前再次检查同名任务；新建任务不使用 `-Force`，若检查后发生竞态则安全失败，绝不覆盖。`-StartAfterInstall` 只在注册完成后再次完整核对任务身份、环境、二进制和进程冲突，再以该已核对的任务对象首次启动；不得改用只按名称的盲启命令。

Supervisor 只有在两次连续检查均证明 `8888` 的 PID、创建时间、程序路径、显式 production config、health 和登录页指纹一致后，才以本地 config 启动子进程。它不接收 tunnel token 参数。运行期间任何 origin 退化都会只停止自己创建且路径仍匹配的 cloudflared 子进程，公网 fail closed；它从不停止、重启或修改 ezBookkeeping，也不采用或终止未知 cloudflared。

## 8. 配置 Ledger-only Cloudflare 规则

以 `config/cloudflare-ledger-rules.example.json` 为逐字段检查清单。除 Free plan 的兼容限速外，每条表达式都必须含精确 hostname：

```text
http.host eq "ledger.66ccff-labs.com"
```

不得启用 zone-wide Always Use HTTPS、全局 HSTS、全局 cache、通配 redirect 或 Cloudflare Access。不得修改 apex/`www` 的 DNS、Vercel、Worker/Page route 或规则。

修改前先通过 Cloudflare API readback 保存各 phase 的 ruleset ID、规则顺序与完整规则备份（备份在仓库外，不含 API token）。若 phase 不存在，用 `POST /zones/{zone_id}/rulesets` 新建；若 phase 已存在，只用 `POST /zones/{zone_id}/rulesets/{ruleset_id}/rules` 新增单条 Ledger rule，不得用 PUT 整体覆盖已有 ruleset。每次写入后立即 API readback 并核对 action、expression、parameters、enabled 与顺序；出现未知规则就停止。

### Single Redirect

表达式：

```text
http.host eq "ledger.66ccff-labs.com" and http.request.full_uri wildcard r"http://*"
```

动态目标为 `concat("https://ledger.66ccff-labs.com", http.request.uri.path)`，设置 `preserve_query_string: true` 且状态码只能是 `301`。如 redirect phase 已有规则，新增时在同一 POST 的单规则请求中使用 `position.before: <EXISTING_RULE_ID>` 指定安全顺序；不整体重写 phase。先以带 path/query 的 HTTP 探针证明 Location 完整且恰为 301。

### Cache Rule

表达式为精确 host，设置 `Bypass cache`。HTML、JSON、API 和认证响应都不得出现 `HIT`、`STALE`、`REVALIDATED` 或 `UPDATING`。

### Response Header Transform

表达式为精确 host，设置：

```text
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow, noarchive
```

初次创建的完整 header rule 不带 HSTS。DNS 生效后，先用明确要求 HSTS 尚未出现的模式完成 HTTP/HTTPS、登录页、cache、WAF、token 与作品集初验：

```powershell
.\scripts\test-ledger-public.ps1 `
  -ComparePortfolioBaseline `
  -PortfolioBaselinePath 'D:\Clawbot\deployment-evidence\portfolio-before-v2.json' `
  -ApiTokenPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt" `
  -McpTokenPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-mcp-token.txt" `
  -PreHstsValidation
```

仅在 MCP 已启用且独立 token 存在时传 `-McpTokenPath`。再用真实浏览器完成登录和 CRUD。初验全部通过后，对 API readback 已确认 ID 的这一条 rule 发送完整 PATCH，仅加入 `Strict-Transport-Security: max-age=86400`。不要设置 `includeSubDomains` 或 `preload`，不要影响 apex/`www`。

### WAF Custom Rule

动作 `Block`，使用一条精确表达式：

```text
http.host eq "ledger.66ccff-labs.com" and (http.request.method eq "TRACE" or (http.request.method eq "POST" and http.request.uri.path eq "/api/register.json"))
```

这只是纵深防护；权威注册门禁仍是 ezBookkeeping `enable_register=false`。

### 登录限速

套餐支持 host、path 和 method 时使用：

```text
http.host eq "ledger.66ccff-labs.com" and http.request.uri.path eq "/api/authorize.json" and http.request.method eq "POST"
```

特征为 source IP，阈值 `5 requests / 10 seconds`，block `10 seconds`。如果部署时 UI 支持 Managed Challenge 且行为经验证，可记录实际选择，但不得降低应用自身每 IP/用户每分钟 5 次失败限制。规则传播可能延迟；验收是在一组连续请求中至少观察到一次 Cloudflare `429`，不假设必然恰在第 6 次出现。

Cloudflare Free plan 可能只有一个 Rate Limiting rule，且表达式只能使用 path/verified-bot 字段。仅在以下三项都有实时证据时才可启用 path-only fallback：

1. 对 `https://66ccff-labs.com/api/authorize.json` 的 GET 和 POST 均直接返回 `404/405/410`，或只精确 `307/308` 到 `https://www.66ccff-labs.com/api/authorize.json`；
2. 对 `https://www.66ccff-labs.com/api/authorize.json` 的 GET 和 POST 均直接返回 `404/405/410`；
3. Cloudflare API readback 证明 `http_ratelimit` phase 当前规则数为 0，并把不含 ID/token 的六字段 schema-v1 摘要写入仓库/OneDrive 外：`schemaVersion=1`、`source=cloudflare-api-readback`、`zoneName=66ccff-labs.com`、`rulesetPhase=http_ratelimit`、`existingRateLimitRuleCount=0`、`capturedUtc=<UTC>`。

fallback 表达式只能是：

```text
http.request.uri.path eq "/api/authorize.json"
```

上线前用 `-ValidateFreePlanRateLimitGate -FreeRateLimitEvidencePath <SANITIZED_JSON>` 运行公网脚本；摘要超过 15 分钟即失效。Free 规则的 API payload 固定为 `characteristics: ["cf.colo.id", "ip.src"]`、`period: 10`、`requests_per_period: 5`、`mitigation_timeout: 10`与 block action；不得增加 `counting_expression`、`requests_to_origin` 或自定义 response。任何探针、套餐能力或槽位为未知/false 时必须跳过并记录，不能冒险改变作品集行为。

## 9. DNS cutover last

在 Universal SSL、HTTPS、Tunnel ingress、origin health、规则和本机 supervisor 均通过后，最后才创建一个 proxied CNAME：

```text
ledger -> <TUNNEL_UUID>.cfargotunnel.com
```

不新增或修改 apex、`www`。在还没有 `ledger` DNS 的情况下，先安装并启动受控 Tunnel 任务，本机确认 supervisor 通过完整 origin/child 验证，再用 Cloudflare API readback 确认该 named Tunnel 已 connected。只有这些前置条件和所有 Ledger-only 规则均通过后，才创建 `ledger` proxied CNAME 作为最后一刀；DNS 生效后立即运行完整公网验收。

proxied CNAME 在公网 DNS 中会 flatten，因此不用公网 `resolveCname(ledger)` 来证明 Tunnel target。必须用 Cloudflare API readback 核对该唯一 `ledger` record 为 `proxied=true`，且 content 恰为已确认 Tunnel UUID 的 `<TUNNEL_UUID>.cfargotunnel.com`；作品集 schema-v2 公网基线负责核对 apex 的 flattened 形态、`www` 的 CNAME 和两者行为指纹，Cloudflare API readback 负责核对 apex/`www` 的权威记录内容。

## 10. 公网、重启与 fail-closed 验收

```powershell
.\scripts\test-ledger-public.ps1 `
  -ComparePortfolioBaseline `
  -PortfolioBaselinePath 'D:\Clawbot\deployment-evidence\portfolio-before-v2.json' `
  -ApiTokenPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt" `
  -VerifyRateLimit
```

仅在 MCP 已按既有交互流程启用且独立 MCP token 存在时，再加入 `-McpTokenPath`。脚本把 token 只读入内存，只向经过固定 HTTPS host 校验的 Ledger URL 发送，并只接受非 2xx；不输出 Authorization、token、响应正文或原始异常。

公网必须证明：

- Cloudflare API readback 证明 DNS 指向专用 Tunnel；HTTP 到 HTTPS 恰为 `301` 且保留 path/query；TLS 有效；
- HTTPS 直接出现 ezBookkeeping 登录应用，没有 Cloudflare Access 页面；
- `POST /api/register.json` 和 `TRACE` 被 Cloudflare 阻止；
- HTML、JSON、API 和认证响应均没有 `HIT/STALE/REVALIDATED/UPDATING`；安全头与 host-only HSTS 正确；
- 公网 API token 与 MCP token 均被拒绝，本机相同能力仍可用；
- `8888` 从 LAN/公网不可直连。

随后在维护窗口使用已批准 cloudflared SHA-256、正式 release、v2 基线与 API token 本地路径运行 `scripts/test-ledger-restart.ps1 -WhatIf`，核对目标后再用同一组参数执行 `-Phase ServiceCycle`。脚本只控制已严格识别的两个计划任务，不调用 `Stop-Process`，也不删除或禁用任务。每次启动正式任务前，`8888` 必须完全无监听；每次启动 Tunnel 任务前，必须不存在任何 cloudflared 进程。若 orphan 或未知 owner 仍存在，脚本以 `RECOVERY_INCOMPLETE` 失败并保持原状，不启动第二份实例。它验证：

1. Tunnel 任务重启后恢复公网；
2. 停止已识别的正式 ezBookkeeping 任务后，supervisor 停止自己的 child，公网失败关闭；
3. 恢复正式任务后，完整 origin 检查通过才恢复 Tunnel；
4. 错误 owner 模拟绝不启动 Tunnel；
5. 最终本机、公网、OpenClaw 和两个任务均回到健康状态。

`ServiceCycle` 不等于机器重启。真实 Windows 重启验收必须分成两次独立运行，且证据文件不得覆盖：

```powershell
# 重启前：在仓库/OneDrive 外创建 owner-only 基线，记录 LastBootUpTime
.\scripts\test-ledger-restart.ps1 @restartArguments `
  -Phase CapturePreReboot `
  -RebootEvidencePath 'D:\Clawbot\deployment-evidence\ledger-reboot-v1.json'

# 用户在 visible terminal 中确认上一步成功后，再真实重启 Windows。
# 重启后：重新构造相同 $restartArguments，只读验证新 LastBootUpTime 严格晚于基线
.\scripts\test-ledger-restart.ps1 @restartArguments `
  -Phase VerifyPostReboot `
  -RebootEvidencePath 'D:\Clawbot\deployment-evidence\ledger-reboot-v1.json'
```

`@restartArguments` 必须包含 `ReleasePath`、`PortfolioBaselinePath`、`ExpectedCloudflaredSha256` 和 `ApiTokenPath`，不含 token 值。两个 phase 都再次核对完整任务身份、本机/公网状态，并执行 `openclaw.cmd gateway status` 与 `openclaw.cmd channels status --probe`；只有 `VerifyPostReboot` 输出固定通过码后，才能认定重启恢复通过。

最后再比较作品集基线。DNS、HTTP redirect、HTTPS/TLS、页面指纹和现有部署必须与上线前一致。

## 11. 证据矩阵

仓库外只保存固定 pass/fail、UTC 时间、版本、状态码、资源名称和 SHA-256。不得保存秘密、身份、SQLite、交易、响应正文或日志样本。

| 类别 | 必须通过的证据 |
| --- | --- |
| 自动化 | 全部测试/build、PS 5.1 parse/WhatIf、endpoint/secret/data scan、manifest、`git diff --check` |
| 本机 | `8888/18888` 精确 owner、独立 DB、正式安全配置、health/login、loopback token/MCP、release-only OpenClaw |
| 公网 | DNS、HTTPS、login、无 Access、注册/TRACE block、限速、cache bypass、安全头、token/MCP 拒绝 |
| 重启 | task 恢复、origin 失效即 fail closed、错误 owner 不启动、无未知进程被停止 |
| WeChat | 新消息恰好一次写入/回复、重复不增写、历史正确、已知验收数据被删除 |
| 作品集 | apex/`www` DNS、redirect、TLS、route 与 fingerprint 全部不变 |
| Git | 分支提交完整；无秘密/数据；未 merge，未 push |

任一行没有真实证据，就不能报告完成。

## 12. 更新、故障和 rollback

### 常规更新

ezBookkeeping 或 cloudflared 更新前：备份、核验来源与版本、先在 `18888` 验证，再进入维护窗口。Clawbot 更新发布新 immutable release，验证后只切换 OpenClaw；不要原地修改旧 release。

### Origin 故障

保持 Tunnel fail closed。先检查正式任务、唯一 `8888` owner、显式 config、health 和页面指纹；不要为了恢复网页而把 origin 改成 `localhost`、LAN IP 或其他端口，不要结束未知占用者。

### Cloudflare 故障

只暂停/删除明确属于 Ledger 的 DNS、规则、任务或 Tunnel；绝不修改 apex/`www`。停止受控 Tunnel 任务不会停止本机 ezBookkeeping 或 OpenClaw。

### 正式迁移回滚

恢复验证过的 INI 和原任务定义，恢复原先运行状态，再将 OpenClaw 切回上一份验证 release。先停止 Ledger Tunnel，防止公开未知状态。SQLite 不自动恢复；只有证明迁移修改了数据、确认备份时点且用户再次明确批准时才恢复。

### 密码或凭据事件

先停止 Ledger Tunnel，再在本机轮换相应凭据并复测。不得把凭据放入命令参数、聊天、Git、OpenClaw 持久配置或日志。密码找回保持关闭；恢复账户只能使用本机受控流程。建议上线稳定后在 ezBookkeeping 同一登录流程中启用原生 2FA/WebAuthn。
