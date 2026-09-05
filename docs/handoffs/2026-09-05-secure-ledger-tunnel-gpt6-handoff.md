# Secure Ledger Tunnel：GPT-6 续接检查点

日期：2026-09-05（Asia/Singapore）

正式网页登录与一次性记录 CRUD、HSTS 后公网安全、作品集回归、ServiceCycle、失败关闭恢复、真实 Windows 重启后的完整恢复，以及微信记账/HTTP 汇总/测试数据清理均已通过。**真实平台同 message ID 重放仍缺触发入口与证据，不能报告全部上线验收完成。** 本文集中记录当前续接点，长期操作合同见 [运维手册](../ledger-cloudflare-runbook.md)。设计已确认，不再 brainstorming。

同日后续微信连续记账出现重复上一笔回执，已确认当时旧生产 release 尚未包含已合入 Git 的修复。现已显式切换至 `0e7c2d7f1f0369552d17d054e2ef24b75be7a482`，包含新可信消息优先和待处理消息阻止旧缓存回退的保护；Gateway、插件、模型与微信通道检查通过。两条新消息的现场验收已通过，用户确认第二条没有重复第一条；两条已知测试交易已精确清理，删除前后预期变化核验通过，未声称原始发消息前三哈希恢复。最新运行检查、清理证据范围与后续边界见 [微信旧回执修复交接](2026-09-05-wechat-stale-reply-repair.md)。下列重启和首次微信验收属于此次修复前的历史证据。

## 开始前必须读取

1. 根目录 [AGENTS.md](../../AGENTS.md)。
2. 本文与 [已确认设计](../superpowers/specs/2026-09-05-ledger-cloudflare-tunnel-design.md)。
3. [实施计划](../superpowers/plans/2026-09-05-secure-ledger-tunnel.md)。
4. [运维手册](../ledger-cloudflare-runbook.md)、[README](../../README.md)、[Windows 交接](../../WINDOWS-HANDOFF.md)。

先只读核验 Git、本机服务和 Cloudflare 当前状态，再继续剩余步骤。既有 Tunnel、DNS、规则均保留；HSTS 现已启用，不要重新创建资源或继续使用 `-PreHstsValidation`。MCP 仍关闭，不为完成网页验收而启用它。

## Git 与保密边界

- Ledger 开发历史包含 `c59da14`、`fc7c4ec`、原交接提交 `65c24c4`。完成 PR 整合后从联网同步的 `main` 维护，无需重新创建 `feat/secure-ledger-tunnel`。
- 用户最新授权为全量 neat、推送、提 PR、合并 `main`、清理无用分支并同步远近端，取代原先功能分支限定。完成时必须联网核对本地 `main`、upstream 与远端 `main` 相同，并验证 PR 合并状态；不能只凭 remote-tracking ref 声称同步完成。
- 整合前本地/远端 `main` 与 `fix/clear-expense-intent` 同为 `93543ab`，该修复已在 `main`，与 Ledger 分支无冲突整合。保留中文金额解析、新可信消息优先及历史去重保护；不得 reset、rebase、覆盖或丢弃现有工作。
- 旧 `fix/clear-expense-intent` worktree 和已合并分支只在再次确认无独有提交、未提交文件、运行依赖或活动任务后清理。根目录 ignored 私密文件、运行数据与其他无关内容继续保留。
- 根目录 `testAccountInfo.txt` 仅验证了存在且被 Git 忽略，未读取。继续只允许这两项检查，不得放入模型上下文、暂存、提交或上传。
- 不输出、记录或上传账户、密码、token、身份、SQLite、交易正文、响应正文或日志。正式网页登录已按用户明确授权完成，凭据未另存为本地文件；不要复述或再使用聊天中的凭据。

## 已提交的修复

| 提交 | 结果 |
| --- | --- |
| `8aa2ea9` | API token 公网 `400` 只有在 `success=false`、`errorCode=200020`、`path=/api/v1/accounts/list.json` 同时精确匹配时才通过；解析后清空响应正文引用，保留原 `401/403` 判定。TDD、focused 91/91、当时完整 448/448 与独立审查通过。 |
| `02ce2c8` | 修复 PowerShell 任务参数数组拼接产生额外空格的问题，保留精确任务身份比较；6/6 与真实任务只读匹配通过。 |
| `98c7fe8` | 修复同类 Tunnel child 命令数组问题；55/55、独立审查及实际子进程精确匹配通过。 |
| `aee5126` | 每个 supervisor fixture 使用独立合成 Local mutex，避免占用生产 mutex；同 fixture 各副本保持同 mutex 和字节一致，保留真实跨进程互斥；TDD、3/3 与独立审查通过。 |
| `37b5fbf` | 整理 tracked-only 私密文件验证及可选 MCP 流程；当时完整回归 511/511。 |
| `bedefb0` | 无冲突整合 `main` 中的 `93543ab`：保留中文金额解析、新可信消息优先与缓存恢复边界，以及 Ledger 的 `8888` 默认端口。独立审查与完整回归通过；未切换生产 release。 |

原 `400/200020` 阻塞已经解决，不要重复实现或放宽为任意 `400`。其语义依据是 ezBookkeeping v1.6.1 的 [API token IP middleware](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/middlewares/api_token_ip_limit.go)、[全局错误定义](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/errs/global.go) 和 [错误码公式](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/errs/error.go)。TRACE `405` 也须与精确 Cloudflare WAF readback 联合作证，不能单独推断 WAF 命中。

## 当前部署与验收证据

本文首次验收使用 `D:\Clawbot\releases\1cf2f739ca92898feed5f24372e9a407ced34b0a`；同日回执修复已切换至 `D:\Clawbot\releases\0e7c2d7f1f0369552d17d054e2ef24b75be7a482`，不直接加载 Git checkout。正式 `127.0.0.1:8888`、隔离测试 `127.0.0.1:18888`、Gateway loopback；旧 `8180` 无监听。正式注册与无效密码找回关闭，API/MCP/trusted-proxy allowlist 保持精确 loopback。生产模型仍是 `gpt-5.6-sol` 与官方 Codex harness，已上线查询能力为 HTTP 确定性汇总。

Tunnel 使用本机 `D:\Clawbot\cloudflared\ledger.yml`，真实 UUID、credential 文件名与 Cloudflare IDs 仅在本机读取后立即处理，不进入本文。已核验官方 cloudflared SHA-256 为 `83E726ED18EA78C5AD5213C4C3A3A27051393950D2BC8ED4DE69BEC12D14EAAE`。只有 `ledger.66ccff-labs.com` 对外发布；Cloudflare Access 未启用，apex/`www` 路由保持不变。

| 验收项 | 最新已完成证据 |
| --- | --- |
| 自动化 | `bedefb0` 整合树完整 bookkeeping 513/513，失败/跳过/取消均 0，231.65 秒；stable-ID build 成功与 3/3；15 个 Windows PowerShell 5.1 脚本解析通过，编译产物无变化。后续文档整理未改变运行代码。 |
| 本机/release | PS 5.1 本机 14/14、immutable manifest/hash/ACL 通过；ServiceCycle 和 CapturePreReboot 又通过完整本机、公网与 OpenClaw 探测。PS 7 的旧静态 ACL API 假失败不能替代 PS 5.1 结果。 |
| 正式浏览器 | 正式登录后创建唯一标记的一次性记录，确认显示与精确一次写入，再修改、删除；只清理该已知记录。账户/分类/交易三个规范化哈希全部恢复基线，未恢复数据库。 |
| HSTS | pre-HSTS 与浏览器闸门通过后，对现有 header rule 执行一次 PATCH，仅添加 `Strict-Transport-Security: max-age=86400`；无 `includeSubDomains`/`preload`，其余四个 header 和规则字段保持。 |
| 公网/作品集 | HSTS 后完整公网探测含 `-VerifyRateLimit` 通过；同一 API token 的 loopback `200` 与公网精确 IP 拒绝配对验证，作品集基线比较通过。 |
| ServiceCycle | 先 WhatIf，再实际完成精确 Tunnel 停启、origin 停止时失败关闭、已知模拟错误 owner 时不启动 Tunnel、最终本机/公网/OpenClaw 恢复。未停止未知进程。 |
| Cloudflare | 真实重启后 12:52 UTC 只读 22/22 通过，Tunnel healthy/4 connections；Ledger DNS、五条规则、五个 header、Access、作品集 DNS/redirect 与全局设置均精确符合预期。主代理独立核验新证据的 22 项布尔值及 owner-only ACL，本轮 Cloudflare 零写入。 |
| 真实重启 | 用户执行 Windows 重启；实际 boot 时间严格晚于原 `ledger-reboot-v1.json` 的 boot/capture 时间。WhatIf 后，12:56 UTC 完整 `VerifyPostReboot` 返回 `LEDGER_REBOOT_ACCEPTANCE_OK` 且退出码 0，本机/发布包/公网/作品集/OpenClaw 检查通过。基线保留不覆盖。 |
| 微信写入/回执 | 用户只发送一条新的测试消息并现场确认只收到一条完整回执；后台精确标记对应一笔金额、分类、时间正确的交易。只读 SQLite 审计 7/7 通过：created 状态、稳定消息 ID、clientSession 绑定、可信队列领取与 API 交易对应；私密字段只在本机内存处理。 |
| 微信汇总/清理 | 用户确认按唯一标记筛选的 HTTP 汇总正确，本机同范围结果一致，查询前后三个规范化哈希不变。复核交易 ID、标记与内容哈希后只删除该已知记录，标记消失，账户/分类/交易三个哈希全部恢复测试前基线。 |
| Git 检查 | 既有 `457d758` 功能分支同步与秘密扫描属于历史检查。本次整合另按实际待发布树完整扫描 tracked 文件、测试/示例及提交说明，文档修改须增量检查后提交；PR 合并状态、最终 main 与分支清理须联网回读确认。远端仓库为 private，未配置 GitHub workflows；不得声称远端 CI 已通过。 |

仓库外证据目录为 `D:\Clawbot\deployment-evidence`，下列证据文件已核验为 owner-only，只含哈希、时间与脱敏检查结果：

- `reboot-wechat-checkpoint-20260905T130459Z.json`：本轮重启与微信实测汇总，保留平台重放待办与 `deploymentComplete=false`。
- `continuation-checkpoint-20260905T122500Z.json`：重启前汇总，明确 `deploymentComplete=false`。
- `browser-crud-baseline-20260905T121124Z.json` 与 `browser-crud-pass-20260905T121429Z.json`：三个规范化哈希基线与完整恢复结果。
- `cloudflare-hsts-patch-20260905T121428Z.json`：一次 HSTS PATCH 与精确回读。
- `cloudflare-readback-post-service-cycle-20260905T122215Z.json`：ServiceCycle 后 Cloudflare 22/22。
- `cloudflare-readback-post-reboot-20260905T125234Z.json`：真实重启后 Cloudflare 22/22，零写入。
- `post-reboot-pass-20260905T125623Z.json`：真实重启与完整恢复通过；仍记录 `deploymentComplete=false`。
- `ledger-reboot-v1.json`：已用于此次真实重启比对的原基线，继续保留。
- `portfolio-before-v2.json`：持续使用的上线前作品集基线。
- `wechat-baseline-20260905T125054Z.json`：微信验收前三个规范化哈希与测试标记不存在的只读证据。
- `wechat-write-pass-20260905T130007Z.json`：精确一条测试交易、金额/分类/时间与用户确认的单条回执；包括查询前哈希与已知交易内容哈希。
- `wechat-trusted-state-pass-20260905T130223Z.json`：只读可信状态关联 7/7；不代表平台重放或数据库可证明发送次数。
- `wechat-query-pass-20260905T130304Z.json`：用户与本机汇总结果一致，查询前后三个哈希不变。
- `wechat-cleanup-20260905T130304Z.json`：只删除已知测试记录、标记消失，三个原始基线哈希恢复；仍记录 `deploymentComplete=false`。

## 剩余项与续接边界

1. 本次真实重启、微信新消息写入、用户现场单条回执确认、HTTP 汇总与测试记录清理均已完成。不要让用户重新发送刚才的记账测试；原测试记录已不存在，业务数据已恢复基线。
2. 平台级同 message ID 重放仍缺真实入口与证据。当前代码保留稳定腾讯 ID 并有插件层合成重放测试，但 monitor/API/命令没有真实 replay 入口；不得重置游标、伪造可信 hooks、直接调用入站处理器或把同正文的新消息当作平台重放。
3. 持久去重表的一条 created 记录及单条交易只能证明当前结果与可信关联，不能证明平台确实投递过两次或历史 POST 次数。待回复记录在发送成功与过期清理时都会删除，且没有发送计数字段；本轮的单条回执结论来自用户现场观察。
4. 有了安全、可核验的真实平台重放能力后，再针对已确认消息取得重复投递及不增写证据；当前只保留此缺口，不为凑齐验收改写生产消息队列或扩大工具权限。
5. 继续按运维手册证据矩阵核验当前状态；任何新代码修改须 TDD、相关回归和独立提交。无新代码、失败或未解决疑虑时不重复全套测试。此前 Git 整合本身没有切换生产；同日回执故障修复已另外完成新 release 的验证与显式切换，后续从新的回执修复交接继续。
6. 所有必需真实证据闭环后，才把未完成状态改为完成。本文记录的网页、单条微信写入与 HTTP 汇总属于此前已通过的验收；同日回执修复切换后的双新消息现场验收及精确测试数据清理已通过，平台重放仍尚未验证。
