# Secure Ledger Tunnel：GPT-6 续接检查点

日期：2026-09-05（Asia/Singapore）

状态：开发主体与大部分真实部署已完成，最终上线验收尚未闭环。本文是下一轮开发会话的唯一临时续接入口；设计不再 brainstorming，长期操作合同仍以 [`../ledger-cloudflare-runbook.md`](../ledger-cloudflare-runbook.md) 为准。

## 2026-09-05 续接进展：先读本节

- 已完整读取本交接要求的文件；确认 `feat/secure-ledger-tunnel` 历史含 `c59da14`、`fc7c4ec`、`65c24c4`。未操作相邻 worktree、未合并、未推送、未重建 Cloudflare 资源。
- 原 API 阻塞已修复并独立提交：`8aa2ea9 fix(ledger): verify API token IP rejection`。TDD、focused 91/91、完整 448/448、独立规范/质量审查及补丁扫描通过。下方 API 阻塞章节保留为历史依据，不要重复实现。
- 本次初始只读检查发现已有正式/测试/Tunnel 任务均停止。精确复核任务、二进制/hash、配置、ACL、runtime 与无端口冲突后，仅启动既有任务；随后 Windows PowerShell 5.1 本机 14/14 通过，旧 `8180` 无监听，非 loopback 地址对 `8888` 的 TCP 探测均不可达。
- pre-HSTS 公网验收及作品集基线对比通过；同一 API token 的 loopback `200` 与公网精确 `400/200020` 已配对验证，只输出状态与布尔值。
- 11:41 UTC 的 Cloudflare readback 证明既有 Tunnel healthy、4 个连接；Ledger DNS/五条规则精确一致，HSTS 仍缺失，Access 未启用，apex/`www` 与既有作品集 redirect 不变。没有进行 Cloudflare 写操作。
- 正式 Ledger 可见浏览器已交给用户自行登录；**尚未完成正式登录及浏览器 disposable CRUD**。下一项真实验收从这里继续；未完成前不得启用 HSTS、ServiceCycle 或后续重启验收。
- readonly restart 预检发现任务参数拼接多插入分隔空格，已按 TDD 修复并独立提交 `02ce2c8 fix(ledger): match exact Tunnel restart arguments`。6/6 回归与实际安装任务的只读精确匹配通过，严格身份比较保留。
- restart 子进程认可命令数组的同类拼接问题也已按 TDD 修复并单独提交：`98c7fe8 fix(ledger): recognize exact Tunnel child commands`。55/55 回归与独立审查通过，实际任务及子进程的只读精确识别通过；没有执行 ServiceCycle。
- supervisor 测试复制品共用生产 mutex 的问题已单独提交 `aee5126 test(ledger): isolate supervisor fixture mutexes`。修复前真实服务运行时为 443/454；修复采用每 fixture 独立的合成 Local mutex，同 fixture 源码/安装/bundle 副本保持相同 mutex 和字节内容，保留真实跨进程互斥。TDD 与独立审查完成，focused 3/3、本轮最终完整 `npm.cmd test` **511/511、0 failed、0 skipped**（236.09 秒），全程没有停止生产服务。
- 本轮另通过 stable-ID build 与 3/3、15 个 Windows PowerShell 5.1 脚本解析、immutable release hash/ACL 验证、restart `WhatIf`、198 个 tracked 文件扫描（禁止产物及强秘密模式均零命中）。11:55 UTC 再次通过本机 14/14、pre-HSTS 公网与作品集基线。以上仍不能代替尚缺的浏览器、HSTS、ServiceCycle、真实重启与微信验收。

本次仓库外脱敏证据：

- `D:\Clawbot\deployment-evidence\continuation-checkpoint-20260905T115734Z.json`（最新 owner-only 检查点；测试代码提交 `aee5126`，含源码哈希及明确待办；`deploymentComplete=false`）
- `D:\Clawbot\deployment-evidence\cloudflare-readback-20260905T114107Z.json`
- `D:\Clawbot\deployment-evidence\pre-hsts-acceptance-20260905T114211Z.json`（记录该时间点已完成与待办，不是完整上线证明）
- `D:\Clawbot\deployment-evidence\browser-crud-before-20260905T114036Z.json`（owner-only；只含账户/分类/交易的规范化哈希，不含正文；尚未执行浏览器 CRUD）

下方“真实部署暂停现场”为较早的交接记录，恢复时以当前只读证据为准。

## 开始前必须读取

依次完整读取：

1. 根目录 [`AGENTS.md`](../../AGENTS.md)
2. [`../superpowers/specs/2026-09-05-ledger-cloudflare-tunnel-design.md`](../superpowers/specs/2026-09-05-ledger-cloudflare-tunnel-design.md)
3. [`../superpowers/plans/2026-09-05-secure-ledger-tunnel.md`](../superpowers/plans/2026-09-05-secure-ledger-tunnel.md)
4. [`../ledger-cloudflare-runbook.md`](../ledger-cloudflare-runbook.md)
5. [`../../README.md`](../../README.md) 与 [`../../WINDOWS-HANDOFF.md`](../../WINDOWS-HANDOFF.md)

随后先做只读 Git、本机和 Cloudflare readback。不要重新创建、覆盖或删除已有资源，不要先启用 HSTS，也不要启用当前仍关闭的 MCP。

## Git 检查点

- 工作分支：`feat/secure-ledger-tunnel`
- 设计基准：`c59da14`，必须是当前分支祖先。
- 原代码检查点：`fc7c4ec fix(ledger): accept edge TRACE rejection`；原交接提交为 `65c24c4`。续接修复见本页首节。
- 2026-09-05 本地引用中，`main` 与 `origin/main` 均为 `93543ab fix(bookkeeping): honor clear expense attempts`。它与功能分支已经分叉，功能分支当时相对 `main` 为 1 behind / 34 ahead。
- 功能分支没有配置 upstream，未推送、未合并。不要根据本地 remote-tracking ref 声称已联网核验远端。
- 另有 `fix/clear-expense-intent` worktree。不要触碰它的文件、暂存区、提交、运行时或配置。
- 禁止 reset、rebase、覆盖或丢弃现有工作。未来若用户批准集成，必须显式保留 `93543ab` 的 main-only 改动并先检查冲突。

根目录可能存在被忽略的 `testAccountInfo.txt`。只允许检查它是否存在及是否被 Git 忽略；禁止用会返回内容的命令读取、放入模型上下文、暂存、提交或上传。它只用于隔离的 `18888` 测试登录，不能用于正式账本。

## 已完成的实现与验证

代码已经覆盖：

- 正式 `127.0.0.1:8888` 与测试 `127.0.0.1:18888` 的强隔离、独立配置/secret/storage/SQLite；自动化不得访问或回退到 `8888`。
- server-side 注册与无效密码找回关闭；API token、MCP、trusted proxy 精确 loopback；登录失败限速合同。
- immutable OpenClaw release 发布、manifest/hash/ACL 核验和可恢复切换。
- Tunnel supervisor 在启动 cloudflared 前核对精确 port owner、程序路径、显式 production config、health JSON 与登录页指纹；退化时只停止自己的 child 并失败关闭。
- Ledger-only Cloudflare 配置、DNS/规则验收、禁止缓存、安全响应头、注册/TRACE 阻断、登录限速、作品集基线对比、精确重启与真实 reboot evidence 流程。
- TRACE 验收接受 Cloudflare WAF `403` 或受限方法的边缘拒绝 `405`；`405` 本身不等于 WAF 命中，必须与规则 API readback 联合作证。

针对 `fc7c4ec` 内容，完整 `clawbot-bookkeeping` 测试为 372/372；TRACE focused suite 为 15/15，`git diff --check` 与 changed-file secret pattern scan 均通过。新会话仍需在最终完成前重跑全部自动化，不能把这些历史结果冒充最终证据。

## 真实部署暂停现场

以下是暂停时已取得的脱敏证据，不是跨会话永远有效的断言；恢复时先只读复核：

- 隔离测试实例精确监听 `127.0.0.1:18888`，使用独立配置、token、SQLite，测试账户已初始化。
- 正式实例已迁移到精确 `127.0.0.1:8888`；旧 `8180` 无监听。正式配置修改前已有验证过的备份。
- 正式注册和找回密码关闭，allowlist 为 loopback，登录限速已设置；MCP 仍为 disabled。
- 生产 OpenClaw 加载仓库外 immutable release：`D:\Clawbot\releases\1cf2f739ca92898feed5f24372e9a407ced34b0a`。
- 已核验的官方 cloudflared SHA-256：`83E726ED18EA78C5AD5213C4C3A3A27051393950D2BC8ED4DE69BEC12D14EAAE`。
- locally managed Tunnel 已连接且 `remote_config=false`；真实 UUID、credential 文件名和 Cloudflare IDs 不得进入 Git 或对话。
- `ledger.66ccff-labs.com` 已是指向该 Tunnel 的 proxied CNAME。不要重建 DNS。
- 五项 Cloudflare 控制已经创建并完成精确 readback：Ledger HTTPS redirect、cache bypass、四个安全响应头、注册/TRACE block、Free-plan path-only 登录限速。不要重复创建规则。
- header rule **尚未加入 HSTS**。这是刻意保留的上线闸门。
- `66ccff-labs.com` 与 `www.66ccff-labs.com` 的 API readback 未变；无 Worker route/wildcard DNS；Cloudflare Access 未启用。
- Windows PowerShell 5.1 的本机验收为 14/14。PowerShell 7 因 .NET Core 缺少静态 `File.GetAccessControl` 会对 release ACL 产生假失败；该脚本按文档使用 `powershell.exe` 5.1。

已知外部证据：

- `D:\Clawbot\deployment-evidence\portfolio-before-v2.json`
- `D:\Clawbot\deployment-evidence\cloudflare-prechange-20260905T094429Z.json`
- `D:\Clawbot\deployment-evidence\ledger-free-rate-limit-gate-v1.json`

最后一份文件的 15 分钟激活窗口已经过期，不能复用来创建或重建 rate rule；规则已经存在，只做只读核验。

## 已解决的原 API 阻塞：精确证明公网 API token 被 IP 边界拒绝

pre-HSTS 公网验收已经越过 TRACE，停在 `LEDGER_PUBLIC_CREDENTIAL_BOUNDARY_FAILED`：

- 同一正式 API token 对 loopback endpoint 返回 `200`。
- 通过 Ledger 公网 hostname 请求相同 endpoint 返回 `400`。
- 缺少 token 的公网请求也返回 `400`，bogus token 返回 `401`。

因此不能把任意 `400` 或任意非 2xx 加入允许列表。ezBookkeeping v1.6.1 官方源码给出了可验证的精确语义：

- [`api_token_ip_limit.go`](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/middlewares/api_token_ip_limit.go#L10-L36)：API-token claim 来自 allowlist 外 IP 时返回 `ErrIPForbidden`。
- [`global.go`](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/errs/global.go#L7-L29)：该错误使用 HTTP `400`，global index 为 `20`。
- [`error.go`](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/errs/error.go#L10-L13)：错误码公式得到 `200020`。
- [`api.go`](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/utils/api.go#L28-L64)：错误 JSON 含 `success`、`errorCode`、`errorMessage`、`path`。

以下 TDD 修复已在 `8aa2ea9` 完成，保留验收约束供回归检查：

1. 先在 `openclaw-plugins/clawbot-bookkeeping/test/ledger-public-scripts.test.mjs` 加失败测试。
2. 修改 `scripts/test-ledger-public.mjs`：API probe 可暂时把响应体留在内存；`400` 只有在 `success === false`、`errorCode === 200020`、`path === "/api/v1/accounts/list.json"` 三项同时精确命中时通过。
3. 解析后立即清空 body 引用；禁止打印、保存、返回原始 body 或 `errorMessage`。原有 `401/403` 继续作为明确拒绝；其他状态一律失败。
4. 更新 runbook 的实际允许语义，跑 focused 和完整测试、`git diff --check`、secret/data scan。
5. 单独提交：`fix(ledger): verify API token IP rejection`。

## 后续必须保持的顺序

1. 已完成只读核验 Git、本机服务、Tunnel/DNS/五项规则、HSTS 仍缺失、apex/`www` 未漂移；新会话仍需复核，不能重建资源。
2. 已完成上面的 API `400/200020` TDD 修复并独立提交。
3. 已用 Windows PowerShell 5.1 通过 pre-HSTS 公网验收；MCP 未启用，不传 `-McpTokenPath`。需要刷新时使用：

   ```powershell
   .\scripts\test-ledger-public.ps1 `
     -ComparePortfolioBaseline `
     -PortfolioBaselinePath 'D:\Clawbot\deployment-evidence\portfolio-before-v2.json' `
     -ApiTokenPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt" `
     -PreHstsValidation
   ```

4. 打开可见浏览器，让用户自行输入**正式** ezBookkeeping 凭据，完成一次 disposable CRUD 并只清理该已知记录。不能读取测试账户文本，也不能用测试账户替代正式登录。
5. 只有第 3、4 步通过后，才对 API readback 已确认的现有 header rule 做完整 PATCH，唯一新增 `Strict-Transport-Security: max-age=86400`；不加 `includeSubDomains` 或 `preload`。随后再次精确 readback。
6. 运行 HSTS 后完整公网验收，改用 `-VerifyRateLimit` 并移除 `-PreHstsValidation`；同时再次比较作品集基线。
7. 对 restart 脚本先运行 `-WhatIf`，核对精确任务后执行 `-Phase ServiceCycle`，证明 origin 不健康时 Tunnel 失败关闭，恢复后服务正常；不得结束未知进程。
8. 创建新的 owner-only `ledger-reboot-v1.json`，运行 `CapturePreReboot`。由用户执行真实 Windows 重启，再运行 `VerifyPostReboot`；不能复用旧 reboot evidence。
9. 请用户从可信微信发送一条新的验收消息；证明恰好一次写入与一次权威回复、平台级重放不重复写、支持的查询正确，然后只清理已知验收记录。
10. 最终重跑全部自动化/build/PowerShell 5.1/parser/WhatIf/secret-data scan，核对 release、Cloudflare、apex/`www`、本机与公网证据，最后检查 Git。只有所有矩阵行都有当前证据才能报告完成。

## 尚缺的完成证据

- 正式浏览器登录与 disposable CRUD。
- HSTS PATCH 与精确 Cloudflare readback。
- HSTS 后公网 token/限速/缓存/安全头与作品集回归。
- ServiceCycle 与 fail-closed 恢复。
- CapturePreReboot、真实重启、VerifyPostReboot。
- 微信一次写入/一次回复、重放去重、查询和已知数据清理。
- 最终全套自动化、release、secret/data、Cloudflare、作品集和 Git 证据。

## 停止条件与保密边界

- 需要登录或授权时，只打开可见浏览器/终端让用户操作；不要索取、回显或存储凭据。
- 不自动结束未知进程、删除未知账户、覆盖任务/Tunnel/DNS/rule 或恢复正式数据库。
- 不把账户、密码、token、身份、SQLite、交易、响应正文或日志写入 Git、终端输出或模型上下文。
- 不启用 Cloudflare Access，不改变 apex/`www`，不把 MCP activation 混入当前收尾。
- 未经用户后续确认，不合并到 `main`，不推送远端。
- 缺少任何真实证据时，明确报告未完成并继续修复；不能用配置存在或旧截图代替当前验收。
