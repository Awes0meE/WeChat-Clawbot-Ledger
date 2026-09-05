# Ledger Cloudflare Tunnel 与运行环境隔离设计

日期：2026-09-05

状态：设计已确认；实现、正式浏览器、公网安全、作品集、服务恢复、真实 Windows 重启和微信记账/HTTP 汇总验收已通过，真实平台同消息 ID 重放仍待验证。最新授权包含 PR 合并 main 与安全清理旧分支；Git 整合不切换生产 release。当前续接点见 [`../../handoffs/2026-09-05-secure-ledger-tunnel-gpt6-handoff.md`](../../handoffs/2026-09-05-secure-ledger-tunnel-gpt6-handoff.md)，实时操作顺序以 [`../../ledger-cloudflare-runbook.md`](../../ledger-cloudflare-runbook.md) 为准。下文保留原设计决策，不作为实时状态证明。

范围：为现有 Windows ezBookkeeping 增加单次登录的公网网页入口，并隔离 Clawbot 开发环境与生产账本

## 背景

当前正式链路为：

```text
WeChat -> Windows OpenClaw -> OpenAI GPT-5.6 Sol / Codex harness
  -> clawbot-bookkeeping -> ezBookkeeping -> 本地 SQLite
```

ezBookkeeping 1.6.1 目前仅监听 Windows loopback。用户希望在其他设备上通过网页查看、修改和删除同一份账目，并继续使用 ezBookkeeping 已有的用户名密码界面，不重新开发一套账本前端。

本设计取代仓库中“家庭网页入口不得直接连接本地 ezBookkeeping”的旧路线。该变化来自用户的明确选择：复用现有 ezBookkeeping UI，通过 Cloudflare Tunnel 发布独立子域名；接受登录页可被公网访问的剩余风险，但账目必须仍由 ezBookkeeping 认证保护。

## 已确认的产品决策

1. 公网地址固定为 `https://ledger.66ccff-labs.com`。
2. `66ccff-labs.com` 与 `www.66ccff-labs.com` 继续进入现有作品集，不能被账本部署改写。
3. 不使用 Vercel 承载账本，也不把 SQLite 或交易变化同步到 GitHub。
4. 不开发新的账本前端，直接使用 ezBookkeeping 的桌面和移动网页。
5. 不启用 Cloudflare Access，避免先过 Cloudflare 再登录 ezBookkeeping 的双重登录。
6. 未登录访问者进入 ezBookkeeping 登录页；已有有效会话时直接进入账本。
7. ezBookkeeping 自助注册必须从服务端关闭。初始部署只保留现有账户，不在仓库记录账户名或密码。
8. 生产 ezBookkeeping 固定监听 `127.0.0.1:8888`；`8888` 为 Ledger 专用端口。
9. Clawbot 开发不得直接加载未完成代码到生产 OpenClaw，也不得使用真实账本做自动化测试。

## 目标

- 在不开放路由器入站端口、不暴露 Windows 公网 IP 的情况下提供 HTTPS 账本入口。
- 通过一次 ezBookkeeping 登录完成查看、创建、修改和删除账目。
- 关闭注册、无效的密码找回和外部认证入口，限制暴力登录。
- 限制 Clawbot 所用 API token 和未来 MCP 接口只能从本机访问。
- 保持微信机器人和网页操作同一份正式账本，修改立即互相可见。
- 将开发代码、测试服务和测试数据库与生产运行时分离。
- 端口被其他程序占用、服务身份异常或账本健康检查失败时停止公网转发，而不是把错误程序暴露在 Ledger 域名下。
- 保持所有真实凭据、Tunnel token、账号资料、SQLite、日志和聊天数据在 Git 之外。

## 非目标

- 不把 ezBookkeeping 或 SQLite 迁移到 Vercel、Cloudflare D1、Supabase 或其他云数据库。
- 不通过 Git commit 同步交易数据。
- 不改变现有微信消息理解、分类、时间解析、去重和权威回执合同。
- 不开放 OpenClaw Gateway、Windows 远程桌面、SMB 或任何其他本机服务。
- 不在本轮实现家庭多用户、角色权限、共享账本或独立只读账号。
- 不修改作品集的 apex/`www` 路由、Vercel 项目或现有重定向。
- 不要求首版启用 ezBookkeeping 2FA；保留能力，后续可在同一登录流程内启用。

## 方案比较

### 方案 A：Cloudflare Tunnel + ezBookkeeping 原生认证

采用。

- 优点：复用当前成熟 UI；网页与微信立即操作同一账本；只登录一次；不开放家庭网络端口。
- 代价：Windows 必须在线；登录页对公网可见；仍需持续更新 ezBookkeeping 并防护登录接口。

### 方案 B：Cloudflare Access + ezBookkeeping 原生认证

不采用。它能在应用外再增加身份门禁，但会形成两次登录，与用户明确要求冲突。

### 方案 C：Vercel 自建前端 + 远程数据库

本阶段不采用。它适合未来的多用户和云端高可用，但需要重新实现认证、账本 UI、数据迁移、同步冲突、备份和审计，远超“先用现有 ezBookkeeping”的范围。

## 最终架构

```text
外部浏览器
  -> HTTPS 443
  -> Cloudflare DNS / TLS / WAF / Rate Limit
  -> 命名 Cloudflare Tunnel
  -> Windows 127.0.0.1:8888
  -> ezBookkeeping 原生登录与 Web/API
  -> 正式 SQLite

微信所有者
  -> OpenClaw 正式运行时
  -> 已发布的 clawbot-bookkeeping
  -> Windows 127.0.0.1:8888
  -> 同一份正式 SQLite
```

Cloudflare 只承担公网入口、TLS、流量过滤和 Tunnel 传输，不成为第二个登录系统。浏览器不会看到 `:8888`，公开地址始终是标准 HTTPS URL。

## 域名与端口合同

| 用途 | 固定值 | 约束 |
| --- | --- | --- |
| 作品集 apex | `66ccff-labs.com` | 保持现有跳转和部署 |
| 作品集主站 | `www.66ccff-labs.com` | 继续指向现有 Vercel 项目 |
| 账本入口 | `ledger.66ccff-labs.com` | 只指向命名 Cloudflare Tunnel |
| 正式 ezBookkeeping | `127.0.0.1:8888` | Ledger 专用，不允许开发服务占用 |
| 测试 ezBookkeeping | `127.0.0.1:18888` | 使用独立测试数据库和测试 token |
| OpenClaw Gateway | `127.0.0.1:18789` | 保持 loopback，不进入 Tunnel |

原正式端口 `8180` 在迁移完成后不再作为 Ledger 生产入口，也不能继续留有旧 Tunnel 路由。未来其他网站必须使用独立端口和独立子域名。

## ezBookkeeping 配置合同

实施时先创建带时间戳的配置与数据库备份，再原子修改配置。公开文档和脚本示例只能包含下面的非敏感值，不能包含任何真实密码或 token。

### Server

```ini
[server]
protocol = http
http_addr = 127.0.0.1
http_port = 8888
domain = ledger.66ccff-labs.com
root_url = https://ledger.66ccff-labs.com/
```

Cloudflare 到本机的最后一跳走 loopback HTTP；公网端到端 HTTPS 在 Cloudflare 边缘终止。不能把 `http_addr` 改成 `0.0.0.0`，也不能在路由器或 Windows 防火墙开放 `8888` 入站访问。

### 登录与用户

```ini
[auth]
enable_internal_auth = true
enable_oauth2_auth = false
enable_two_factor = true
enable_forget_password = false

[user]
enable_register = false
```

- `enable_register=false` 是权威注册门禁；隐藏前端入口不能替代服务端禁用。
- 实施前只读取用户数量并确认恰好存在一个既有账户；发现额外账户时停止，不自动删除。
- 本机未启用 SMTP，因此关闭“忘记密码”。密码遗忘时通过本机受控恢复流程处理。
- `enable_two_factor=true` 只保留用户自行启用 2FA 的能力，首版不强制设置，也不增加 Cloudflare 登录页。

### 会话与登录限速

```ini
[security]
trusted_proxy_ips = 127.0.0.1/32
token_expired_time = 604800
token_min_refresh_interval = 86400
max_failures_per_ip_per_minute = 5
max_failures_per_user_per_minute = 5
```

会话令牌有效期设为 7 天，前端最短每日刷新一次。未登录或令牌失效时返回 ezBookkeeping 登录页；有效会话直接进入账本。服务端同时按来源 IP 和用户名限制错误密码尝试。

### 本机 API 与 MCP

正式 Clawbot 仍需 API token，因此不关闭 API token 功能，但必须限制来源：

```ini
[security]
enable_api_token = true
api_token_allowed_remote_ips = 127.0.0.1

[mcp]
mcp_allowed_remote_ips = 127.0.0.1
```

- `trusted_proxy_ips` 使用 ezBookkeeping 所需的 CIDR 语法缩小为精确的 `127.0.0.1/32`，不再保留全部私有网段默认值。
- API token 和 MCP token 继续分离，并只从受限的本机秘密文件读取。
- `enable_mcp` 的当前启用状态由既有 MCP 激活流程决定，本设计不擅自切换；无论是否启用，公网来源都不能使用 MCP。
- 上线验收必须实际证明：本机 Clawbot 可继续访问 API，而通过 Ledger 公网域名使用 API token 或 MCP token 会被拒绝。

## Cloudflare 配置合同

### Tunnel 与 DNS

- 创建一个专用于 Ledger 的命名 Tunnel。
- 公共 hostname 仅为 `ledger.66ccff-labs.com`。
- origin 固定为 `http://127.0.0.1:8888`，不能使用 `localhost`、LAN IP 或通配地址。
- Tunnel 凭据只保存在 Windows 受限目录或 Windows 服务配置中，不写进仓库、命令历史、日志或聊天。
- DNS 只新增 Tunnel 管理的 `ledger` 记录；实施前后都要验证 apex 和 `www` 的解析、跳转与页面不变。

### 边缘安全规则

除下述登录限速兼容项外，所有规则只匹配 Ledger hostname；若当前 Cloudflare 套餐无法把某项规则限定到该 hostname，则跳过该项并记录，而不是修改整站行为影响作品集。Cloudflare Free 的限速表达式若只能匹配路径，可以仅匹配精确路径 `/api/authorize.json`，但必须先确认 apex 和 `www` 不使用该路径，并在部署后复测作品集。

1. 强制 HTTP 跳转 HTTPS。
2. 整个 Ledger hostname 设置 Cache Bypass；不得缓存 HTML、JSON、API 响应或认证内容。
3. 对实际登录接口路径 `/api/authorize.json` 增加 Cloudflare 限速或 Managed Challenge；套餐支持方法条件时再限定为 `POST`。ezBookkeeping 自身的每 IP、每用户每分钟 5 次失败限制仍是第二层门禁。
4. 明确阻止 `POST /api/register.json`，作为 `enable_register=false` 之外的纵深防护。
5. 阻止不需要的 `TRACE` 方法；保留应用正常增删改所需的 `GET`、`POST`、`PUT`、`PATCH` 和 `DELETE`。
6. 为 Ledger hostname 添加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 和 `X-Robots-Tag: noindex, nofollow, noarchive`。
7. HTTPS 验证完成后仅在 Ledger hostname 添加 HSTS；不对 apex/`www` 或整个区域启用未经验证的全局 HSTS。
8. 不使用可能破坏 SPA 或移动端功能的激进 JavaScript 重写、全站交互挑战或未经验证的 CSP。

搜索引擎禁止规则只降低意外收录概率，不是访问控制。没有 Cloudflare Access 时，任何人仍可能看见登录页；真正的账目访问边界是 ezBookkeeping 认证、登录限速和可选原生 2FA。

## 端口归属与故障关闭

`8888` 被视为生产资源，而不是普通开发端口。

实施需要提供一个受控的 Ledger Tunnel 启动/监督流程：

1. 启动前检查 `8888`；若已被占用，只接受进程路径与预期 ezBookkeeping 可执行文件一致的监听者。
2. 若端口由其他程序占用，立即停止并报告 PID 和程序路径；不得自动结束未知进程。
3. 等待 `http://127.0.0.1:8888/healthz.json` 返回健康结果，并完成 ezBookkeeping 特征检查后，才启动或保持 Tunnel。
4. 运行期间定期复核端口监听进程与健康状态。
5. ezBookkeeping 退出、健康检查失败或端口所有者变化时，停止 Tunnel，公网入口失败关闭。
6. ezBookkeeping 恢复且重新通过完整检查后，Tunnel 才能恢复。

该监督流程必须以隐藏的 Windows 后台任务或服务运行，支持登录后自动启动、异常恢复和受控日志；日志不得包含请求体、cookie、Authorization header、token、账户名或账目内容。

## 开发与生产隔离

### 生产运行时

- 正式 OpenClaw 不再直接加载正在编辑的仓库路径。
- 生产插件从独立发布目录加载，例如版本化的本机 release 目录；该目录只由通过检查的发布步骤更新。
- 正式配置固定指向 `http://127.0.0.1:8888` 和正式 token 文件。
- 更新 Clawbot 插件或重启 OpenClaw 不得停止 ezBookkeeping 或 Cloudflare Tunnel。

### 开发运行时

- 仓库工作区只用于编辑、构建和自动化测试。
- 集成测试使用 `127.0.0.1:18888`、独立 SQLite、独立账户和独立 token。
- 单元测试继续使用临时目录、fixture 或模拟 HTTP 服务，不能访问 `8888`。
- 测试配置必须显式标记为非生产；缺少测试目标时失败关闭，不能回退到正式 URL。
- 未提交、未完成或仅存在于功能分支的代码不会被生产 OpenClaw 自动加载。

### 发布边界

只有以下条件全部满足后，发布步骤才能更新生产插件：

1. 两个插件的既有测试和构建全部通过。
2. 新增的生产/测试隔离检查通过。
3. 仓库秘密扫描通过。
4. 生产数据库已经创建可验证、可恢复的备份。
5. 目标 release 目录完整生成并通过健康检查。
6. 明确切换生产 OpenClaw 到该 release，并在切换失败时恢复上一版本。

## 数据一致性

网页和微信最终访问同一份正式 SQLite：

- 微信成功记账后，网页刷新即可看到新交易。
- 网页创建、修改或删除交易后，Clawbot 后续查询读取修改后的结果。
- 已经发送过的微信成功回执是当时写入结果的审计事实，不会因网页后续修改而被追溯改写。
- Clawbot 的消息去重状态与 ezBookkeeping 交易数据仍是不同的本地状态库；网页删除交易不会清除消息去重记录，也不能通过重发同一个微信 message ID 恢复交易。
- SQLite 不进入 Git，不通过 Vercel 构建同步，也不由 Cloudflare 缓存。

## 部署顺序与回滚

### 部署顺序

1. 只读探测当前 Git、OpenClaw、ezBookkeeping、端口、计划任务、MCP 和域名状态。
2. 备份 ezBookkeeping 配置与正式 SQLite，并验证备份可读。
3. 建立 `18888` 测试实例，在测试数据库上完成网页 CRUD、注册禁用、登录和 token 限制验证。
4. 准备独立生产 release 目录并切换 OpenClaw 配置，但暂不发布公网 DNS。
5. 在同一维护窗口把正式 ezBookkeeping、正式 Clawbot API 基址和监督检查从 `8180` 协调切换到 `8888`。
6. 验证本机健康、微信写入/查询路径与网页本地登录。
7. 安装并认证 `cloudflared`，创建命名 Tunnel 和 `ledger` DNS。
8. 应用只针对 Ledger hostname 的缓存、安全头、注册拦截和登录限速规则。
9. 执行完整公网与重启验收，确认作品集未受影响。
10. 删除旧 `8180` Tunnel/运行时引用，但不删除备份。

Cloudflare 登录或授权必须由用户在可见浏览器或终端完成。实施工具不得索取、记录或回显 Cloudflare 密码、API token 或 Tunnel token。

### 回滚

- 任何正式切换失败都先停止 Ledger Tunnel，避免暴露未知状态。
- 恢复带时间戳的 ezBookkeeping 配置和上一版生产插件，将内部调用退回已验证的旧端口与旧 release。
- 数据库只有在证明迁移步骤修改了数据且用户明确批准时才从备份恢复；不能用旧备份覆盖可能包含新交易的正式数据库。
- DNS 或规则错误只回滚 `ledger` 相关记录，不能修改 apex 或 `www`。
- 回滚后重新验证微信、账本健康和作品集；保留脱敏失败记录供修复。

## 错误处理

| 情况 | 必须行为 |
| --- | --- |
| `8888` 被未知程序占用 | 停止部署，不杀进程，不启动 Tunnel |
| ezBookkeeping 不健康 | Tunnel 保持停止；微信写入按既有失败/未知语义处理 |
| Tunnel 离线 | 网页不可用；本机微信记账仍可继续 |
| Windows 或网络离线 | 网页不可用；恢复后由后台任务重新检查并启动 |
| Cloudflare 规则影响作品集 | 立即回滚该规则并验证 apex/`www` |
| 注册入口仍可提交 | 不得上线；同时修正 ezBookkeeping 和边缘门禁 |
| 公网可使用 API/MCP token | 严重验收失败，停止 Tunnel 后修复 |
| 发现多个既有用户 | 停止并请求用户决定，不自动删除账户 |
| 数据备份不可验证 | 停止正式切换 |

## 验收标准

### 自动化与本机

1. 仓库所有既有 bookkeeping 测试、stable-ID 构建与测试通过。
2. 配置脚本支持预演、原子备份、原子修改和安全回滚，不显示秘密。
3. 正式端口只能是 `127.0.0.1:8888`；LAN 地址和 `0.0.0.0:8888` 均不可连接。
4. 测试实例只使用 `18888` 和独立数据库；自动化测试无法回退到 `8888`。
5. 正式 OpenClaw 加载独立 release，而不是当前工作区。
6. 端口身份检查能拒绝非 ezBookkeeping 进程；异常时 Tunnel 失败关闭。
7. 本机 Clawbot API 访问成功；公网 API token 和 MCP token 访问失败。

### 公网网页

1. `http://ledger.66ccff-labs.com` 跳转至 HTTPS。
2. 未登录访问最终进入 ezBookkeeping 登录页；有效会话只需一次登录即可进入账本。
3. 登录页没有可用的注册流程，直接访问注册页面或调用 `POST /api/register.json` 均不能创建用户。
4. 错误密码受到 ezBookkeeping 与 Cloudflare 两层限速；正确凭据在限速解除后仍可正常登录。
5. 登录后可以查看、创建、修改和删除交易，移动端布局可用。
6. 完整 CRUD 先在测试数据库验证；正式环境只创建一笔带唯一测试标记的临时交易，验证修改与删除后确认零残留。
7. Ledger 响应不被 Cloudflare 缓存，包含约定安全响应头且不允许第三方页面嵌入。
8. 停止 ezBookkeeping 或替换 `8888` 监听进程时，Tunnel 不会把其他应用返回给公网。
9. Windows 重启后 ezBookkeeping、监督流程和 Tunnel 按顺序恢复，无需手工重新部署。

### 回归

1. `66ccff-labs.com` 仍按原规则进入 `www.66ccff-labs.com`，作品集页面正常。
2. `www.66ccff-labs.com` 的 Vercel 部署、HTTPS 和资源加载不变。
3. 微信明确记账、疑问确认、汇总和已启用的历史查询能力不回退。
4. 网页修改交易后，微信查询能读到新状态；网页操作不能绕过 ezBookkeeping 权限。
5. Git 状态不包含数据库、凭据、Cloudflare 配置实值、Tunnel token、日志或账户信息。

## 运维与剩余风险

- 线上可用性依赖 Windows 主机、电源、家庭网络、ezBookkeeping 和 Cloudflare Tunnel；本设计不提供云端高可用。
- 不使用 Cloudflare Access 意味着公网访客可以到达登录页。WAF 和限速降低攻击概率，但不能消除 ezBookkeeping 自身漏洞或密码泄露风险。
- 应定期升级 ezBookkeeping 与 `cloudflared`，升级前备份并在 `18888` 测试实例验证。
- 正式 SQLite 至少保留本机版本化备份，并另有不经过 Git 的加密离机备份；恢复演练必须避免覆盖新交易。
- 建议用户上线后在 ezBookkeeping 内启用原生 2FA 或 WebAuthn。它属于同一次应用登录流程，不会增加 Cloudflare 登录页，但首版不强制。
- Cloudflare 安全事件、重复登录失败和 Tunnel 异常只记录必要元数据；不得记录账目正文或认证秘密。

## 实施交付物

后续实施计划至少应覆盖：

- 可预演、可回滚的 ezBookkeeping `8888` 配置迁移脚本；
- `18888` 测试实例与独立测试数据库初始化；
- 生产插件 release 构建、切换与回滚流程；
- Ledger Tunnel 安装、监督、端口身份检查和健康检查；
- 脱敏的 Cloudflare DNS/WAF/Cache/Response Header 配置说明；
- 自动化安全检查与公网浏览器验收；
- `README.md`、`WINDOWS-HANDOFF.md` 和部署说明同步更新。

真实账户、密码、API token、MCP token、Cloudflare token、微信身份、交易内容、SQLite 路径实值和日志样本均不属于实施交付物，不能进入 Git。
