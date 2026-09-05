# Secure Ledger Tunnel：GPT-6 续接检查点

日期：2026-09-05（Asia/Singapore）

正式网页登录与一次性记录 CRUD、HSTS 后公网安全、作品集回归、ServiceCycle 和失败关闭恢复均已通过。重启前证据已生成；**真实 Windows 重启后的恢复与微信消息验收仍未完成，不能报告全部上线验收完成。** 本文集中记录当前续接点，长期操作合同见 [运维手册](../ledger-cloudflare-runbook.md)。设计已确认，不再 brainstorming。

## 开始前必须读取

1. 根目录 [AGENTS.md](../../AGENTS.md)。
2. 本文与 [已确认设计](../superpowers/specs/2026-09-05-ledger-cloudflare-tunnel-design.md)。
3. [实施计划](../superpowers/plans/2026-09-05-secure-ledger-tunnel.md)。
4. [运维手册](../ledger-cloudflare-runbook.md)、[README](../../README.md)、[Windows 交接](../../WINDOWS-HANDOFF.md)。

先只读核验 Git、本机服务和 Cloudflare 当前状态，再继续剩余步骤。既有 Tunnel、DNS、规则均保留；HSTS 现已启用，不要重新创建资源或继续使用 `-PreHstsValidation`。MCP 仍关闭，不为完成网页验收而启用它。

## Git 与保密边界

- 继续使用 `feat/secure-ledger-tunnel`；已确认历史包含 `c59da14`、`fc7c4ec`、原交接提交 `65c24c4`。
- 用户后续已授权全局 neat、同步远近端和清理工作区，覆盖原先“不推送”限制，范围为当前功能分支。同步后必须联网核对本地 HEAD、upstream 与远端 HEAD 相同；不能只凭 remote-tracking ref 声称同步完成。
- 本轮联网 fetch 后，本地 `main` 与 `origin/main` 均为 `93543ab`，它有功能分支尚未包含的独立修复。用户尚未授权合并 `main`；不得 merge、reset、rebase、覆盖或丢弃现有工作。
- 不触碰相邻 `fix/clear-expense-intent` worktree 的文件、暂存区、提交、运行时或配置。清洁工作区不等于删除 ignored 数据或其他 worktree。
- 根目录 `testAccountInfo.txt` 仅验证了存在且被 Git 忽略，未读取。继续只允许这两项检查，不得放入模型上下文、暂存、提交或上传。
- 不输出、记录或上传账户、密码、token、身份、SQLite、交易正文、响应正文或日志。正式网页登录已按用户明确授权完成，凭据未另存为本地文件；不要复述或再使用聊天中的凭据。

## 已提交的修复

| 提交 | 结果 |
| --- | --- |
| `8aa2ea9` | API token 公网 `400` 只有在 `success=false`、`errorCode=200020`、`path=/api/v1/accounts/list.json` 同时精确匹配时才通过；解析后清空响应正文引用，保留原 `401/403` 判定。TDD、focused 91/91、当时完整 448/448 与独立审查通过。 |
| `02ce2c8` | 修复 PowerShell 任务参数数组拼接产生额外空格的问题，保留精确任务身份比较；6/6 与真实任务只读匹配通过。 |
| `98c7fe8` | 修复同类 Tunnel child 命令数组问题；55/55、独立审查及实际子进程精确匹配通过。 |
| `aee5126` | 每个 supervisor fixture 使用独立合成 Local mutex，避免占用生产 mutex；同 fixture 各副本保持同 mutex 和字节一致，保留真实跨进程互斥；TDD、3/3 与独立审查通过。 |
| `37b5fbf` | 整理 tracked-only 私密文件验证及可选 MCP 流程；运行代码与上述修复一致。最新完整回归见下表。 |

原 `400/200020` 阻塞已经解决，不要重复实现或放宽为任意 `400`。其语义依据是 ezBookkeeping v1.6.1 的 [API token IP middleware](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/middlewares/api_token_ip_limit.go)、[全局错误定义](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/errs/global.go) 和 [错误码公式](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/errs/error.go)。TRACE `405` 也须与精确 Cloudflare WAF readback 联合作证，不能单独推断 WAF 命中。

## 当前部署与验收证据

生产继续使用 `D:\Clawbot\releases\1cf2f739ca92898feed5f24372e9a407ced34b0a`，不直接加载 Git checkout。正式 `127.0.0.1:8888`、隔离测试 `127.0.0.1:18888`、Gateway loopback；旧 `8180` 无监听。正式注册与无效密码找回关闭，API/MCP/trusted-proxy allowlist 保持精确 loopback。生产模型仍是 `gpt-5.6-sol` 与官方 Codex harness，已上线查询能力为 HTTP 确定性汇总。

Tunnel 使用本机 `D:\Clawbot\cloudflared\ledger.yml`，真实 UUID、credential 文件名与 Cloudflare IDs 仅在本机读取后立即处理，不进入本文。已核验官方 cloudflared SHA-256 为 `83E726ED18EA78C5AD5213C4C3A3A27051393950D2BC8ED4DE69BEC12D14EAAE`。只有 `ledger.66ccff-labs.com` 对外发布；Cloudflare Access 未启用，apex/`www` 路由保持不变。

| 验收项 | 最新已完成证据 |
| --- | --- |
| 自动化 | `37b5fbf` 完整 bookkeeping 511/511，失败/跳过/取消均 0，250.69 秒；stable-ID build 成功与 3/3；15 个 Windows PowerShell 5.1 脚本解析通过，编译产物无变化。 |
| 本机/release | PS 5.1 本机 14/14、immutable manifest/hash/ACL 通过；ServiceCycle 和 CapturePreReboot 又通过完整本机、公网与 OpenClaw 探测。PS 7 的旧静态 ACL API 假失败不能替代 PS 5.1 结果。 |
| 正式浏览器 | 正式登录后创建唯一标记的一次性记录，确认显示与精确一次写入，再修改、删除；只清理该已知记录。账户/分类/交易三个规范化哈希全部恢复基线，未恢复数据库。 |
| HSTS | pre-HSTS 与浏览器闸门通过后，对现有 header rule 执行一次 PATCH，仅添加 `Strict-Transport-Security: max-age=86400`；无 `includeSubDomains`/`preload`，其余四个 header 和规则字段保持。 |
| 公网/作品集 | HSTS 后完整公网探测含 `-VerifyRateLimit` 通过；同一 API token 的 loopback `200` 与公网精确 IP 拒绝配对验证，作品集基线比较通过。 |
| ServiceCycle | 先 WhatIf，再实际完成精确 Tunnel 停启、origin 停止时失败关闭、已知模拟错误 owner 时不启动 Tunnel、最终本机/公网/OpenClaw 恢复。未停止未知进程。 |
| Cloudflare | ServiceCycle 后 12:22 UTC 只读 22/22 通过，Tunnel healthy/4 connections；Ledger DNS、五条规则、五个 header、Access、作品集 DNS/redirect 与全局设置均精确符合预期。本轮不再写 Cloudflare。 |
| 重启前 | 新建 owner-only `ledger-reboot-v1.json` 已成功；它记录真实 boot/capture 时间，不得覆盖、复用旧版本或以 ServiceCycle 代替重启。 |
| 发布前扫描 | 对拟推送历史的 41 个提交、172 个不同 blob 与提交说明进行检查；禁止产物、强秘密模式和未解释的匹配均为零。最终文档提交仍需增量检查。远端仓库为 private，未配置 GitHub workflows；不得声称远端 CI 已通过。 |

仓库外证据目录为 `D:\Clawbot\deployment-evidence`，下列证据文件已核验为 owner-only，只含哈希、时间与脱敏检查结果：

- `continuation-checkpoint-20260905T122500Z.json`：当前汇总，明确 `deploymentComplete=false`。
- `browser-crud-baseline-20260905T121124Z.json` 与 `browser-crud-pass-20260905T121429Z.json`：三个规范化哈希基线与完整恢复结果。
- `cloudflare-hsts-patch-20260905T121428Z.json`：一次 HSTS PATCH 与精确回读。
- `cloudflare-readback-post-service-cycle-20260905T122215Z.json`：最新 Cloudflare 22/22。
- `ledger-reboot-v1.json`：已经捕获、等待真实 Windows 重启后的核对基线。
- `portfolio-before-v2.json`：持续使用的上线前作品集基线。

## 剩余步骤：严格按顺序

1. 保留当前服务运行，由用户现场执行真实 Windows 重启；用户在外时不要自动重启主机。重启前证据已经完成，不必再次 `CapturePreReboot`。
2. 用户确认已重启后，在仓库根目录的 **Windows PowerShell 5.1** 中重建以下参数，先 WhatIf，再运行 `VerifyPostReboot`。只接受 `LEDGER_REBOOT_ACCEPTANCE_OK`，并确认退出码成功；执行输出须按运维保密合同处理。

   ```powershell
   $restartArguments = @{
     ReleasePath = 'D:\Clawbot\releases\1cf2f739ca92898feed5f24372e9a407ced34b0a'
     PortfolioBaselinePath = 'D:\Clawbot\deployment-evidence\portfolio-before-v2.json'
     ExpectedCloudflaredSha256 = '83E726ED18EA78C5AD5213C4C3A3A27051393950D2BC8ED4DE69BEC12D14EAAE'
     ApiTokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt"
   }
   .\scripts\test-ledger-restart.ps1 @restartArguments `
     -Phase VerifyPostReboot `
     -RebootEvidencePath 'D:\Clawbot\deployment-evidence\ledger-reboot-v1.json' `
     -WhatIf
   .\scripts\test-ledger-restart.ps1 @restartArguments `
     -Phase VerifyPostReboot `
     -RebootEvidencePath 'D:\Clawbot\deployment-evidence\ledger-reboot-v1.json'
   ```

3. 由用户从可信微信发送新的验收消息。证明一次写入、一次权威回复、平台级同一消息重放不增写、支持的 HTTP 汇总正确，再只删除已知验收记录。不得把发送相同正文的新消息当作同一 message ID 重放，也不能用浏览器 CRUD 或服务探测替代微信端到端证据。MCP 未启用，历史查询不计为已上线。
4. 按运维手册完整证据矩阵收尾：复核本机/release、公网、Cloudflare、作品集和 Git 当前状态；任何新代码修改须 TDD、相关回归和独立提交。现有全套测试通过后，只有新改动、失败或未解决疑虑才需要重复全套测试。
5. 只有上述全部通过，才把当前未完成状态改为已完成。缺少实际重启或微信证据时明确保留待办，不重做已有资源、不自动恢复正式数据库、不制造通过结果。
