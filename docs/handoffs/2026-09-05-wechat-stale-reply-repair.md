# 2026-09-05 微信旧回执修复交接

更新于 2026-09-05，时区 `Asia/Singapore`。修复已部署到生产，切换脚本及后置运行检查通过，换行约定修正后严格本机重验 14/14 全部通过、退出码 0；双新微信消息验收仍待用户回应，真实平台同 ID 重放仍缺触发入口。本文只记录脱敏代码、计数、版本、路径和状态，不保存业务消息、身份、凭据或运行日志。

## 当前状态

| 项目 | 已确认状态 |
| --- | --- |
| 当前生产 release | `D:\Clawbot\releases\0e7c2d7f1f0369552d17d054e2ef24b75be7a482`，已发布、校验并完成切换 |
| 回滚 release | `D:\Clawbot\releases\1cf2f739ca92898feed5f24372e9a407ced34b0a`，保留且全量 verifier 通过 |
| 回复修复 | `93543ab` 的新可信消息优先修复及 `c5e2e25` 的待处理消息缓存回退保护已包含在新 release |
| managed hook | 三个文件已安装、direct import 验证通过、Gateway 已重启并确认实际注册 |
| 旧 memory 文件 | 四个文件已保全迁出，迁出前后 SHA-256 4/4 一致；未读正文，未删除 |
| 旧 release 完整性 | 四文件迁出后 PS 5.1 全量 verifier 返回 `ROLLBACK_RELEASE_VERIFIED`，退出码 0 |
| 切换 | `OPENCLAW_RELEASE_SWITCHED`、退出码 0；Gateway/channel/plugin/Codex/model 检查通过 |
| 切换后本机复核 | 首轮 13/14，仅 `tunnel_runtime_integrity` 因源码换行字节差异失败；修正后严格重验 14/14 全部通过，退出码 0 |
| 同次公网检查 | 切换前使用 `ApiTokenPath` 与 `ComparePortfolioBaseline`，返回 `LEDGER_PUBLIC_ACCEPTANCE_OK`；未额外重跑限速验证 |
| 微信现场验收 | 本机内存三哈希基线已准备，测试标记原本不存在；已请用户在现有会话发送第一条，待回应后再进行第二条 |
| 平台同 ID 重放 | 缺少真实触发入口，原验收缺口保留 |

正式账本仍为 `127.0.0.1:8888`，隔离测试为 `127.0.0.1:18888`；Gateway 为 loopback，生产模型仍为官方 Codex harness 上的 `gpt-5.6-sol`。本次修复部署不改账、不补账，也不重放此前业务消息。

## 故障与代码证据

用户连续记账期间有两次新微信消息重复收到上一笔回执。运行证据与源码比较确认：当时生产旧 release 未包含已进入 `main` 的 `93543ab`。Git 合并成功没有切换运行代码。

旧实现先恢复同一工具实例中缓存的权威结果；一旦找到旧缓存，就跳过新 durable 可信入站的领取，并可直接返回旧成功回执。跨插件实例的新消息因此可能被上一轮结果遮蔽。新可信消息优先修复先尝试 durable 关联，再决定是否恢复旧缓存。

`c5e2e25` 补齐两个相邻边界：存在多个同接收者、有效期内的新 durable 候选时拒绝歧义；新可信取消消息与工具传入的确认决定不符时拒绝该调用。两者都不得回退旧成功回执或新增交易。决定不匹配时不领取该新消息，随后正确的取消调用仍可处理它。所有者身份、接收者唯一匹配、可信消息 ID 去重及正式端口边界保持原合同。

## 合成回归证据

- 在隔离临时源码副本中，以 fake fetch、临时 SQLite 和禁止真实网络的 loader 运行既有 fresh durable 回归：旧 release 副本 0 通过 / 1 失败，冻结 `main` 副本 1 通过 / 0 失败。未加载运行实例或使用正式数据库。
- 新回归覆盖旧成功回执后不同金额的新消息应产生新 POST 和新回执、多个新候选不得恢复旧回执，以及新取消消息遇到错误 confirm 参数应拒绝且保持未领取。
- `c5e2e25` 回复回归完整 516/516 通过。`48225a1` 只修正 CRUD 源码检查的 Windows CRLF 兼容，不改变运行行为。
- `0e7c2d7` 的完整 `npm test` 退出码为 0；该次结果未捕获总数，不据此填写测试数量。独立 managed hook 回归 14/14 通过。

自动化与源码 A/B 证明代码边界，不能替代切换后的真实微信验收。

## 本机完整性复核的换行修复

切换后只读确认 workspace 与两条 plugin 路径均为新 release，`8888` owner、程序、配置和 Gateway loopback 正常。首轮本机完整验收为 13/14，仅 `tunnel_runtime_integrity` 失败：两个已安装 Tunnel runtime 脚本与仓库源码只有 CRLF/LF 差异，原因是 `.gitattributes` 原先的 `*.ps1 eol=crlf` 在 Git checkout 后改变了源码字节。

现已将 PowerShell 源码约定改为 `eol=lf`，归一工作区 15 个 `.ps1` 文件；脚本本身 Git diff 为 0，两个 installed/source 原始 SHA-256 已分别严格相等。未修改已部署 Tunnel 脚本、规则或资源，也未放宽 verifier。PS 5.1 解析 15/15、CRUD 回归 7/7 通过；随后严格本机重验 14/14 全部通过、退出码 0。该源码换行约定已单独提交为 `2cbb103`（`fix(build)`），无需重新发布运行 release。

## immutable workspace 保护

官方 session-memory 会在 reset 相关事件中生成 workspace memory 文件，这与专用 bookkeeper 的 immutable release 合同冲突。本次提供同名 managed hook，源码为 `openclaw-hooks/session-memory/{HOOK.md,handler.js,guard.mjs}`，安装位置为 `%USERPROFILE%\.openclaw\hooks\session-memory\`。保留原 enabled 设置，不增加 `extraDirs`，不修改 bundled 源码。

只有 `event.context.agentId === 'bookkeeper'` 时跳过 session-memory；`main` 和其他代理仍原样调用官方处理器，保留返回值、异常及 Promise。`command:new`、`command:reset`、`session:auto-reset` 的已核对官方事件路径均提供解析后的 agent ID。普通 transcript 持久化与 reset 策略不变。

入口固定 Windows npm-global OpenClaw 2026.8.2，import 前校验官方 bundled `handler.js` 与 `HOOK.md` 的双 SHA-256。版本或哈希变化必须先审核后更新 pin；验证错误只输出固定错误码。同名 managed 覆盖加载失败不会回退 bundled hook，必须阻止 release 切换。

三文件安装及 direct import 已通过。官方 Gateway stop 在非交互维护时使用 `--force`，随后 start 已完成。运行注册证据为：Gateway 启动 INFO 实际 `loadedCount=1`，configured/eligible 均为 1 且唯一条目为 managed `session-memory`，loader 失败数为 0。CLI inventory 或 `hooks.status` 本身仅证明发现与 eligibility；独立 Node 进程的 internal hook map 也不能代表 Gateway 进程。

四个已确认的旧 memory 文件已迁出至仓库外受限归档，迁出前后哈希 4/4 一致。未读正文、未删除文件、未修改 manifest 来容纳额外文件；精确归档定位留在本机，不进入 Git 或同步上传。迁出后旧 release 的 PS 5.1 全量 verifier 已通过，可保留为经校验的回滚版本。

## 继续执行

1. 本机完整复核已通过。新会话先只读核对 active release、Gateway 与微信 channel 状态，不由文档推断当前服务状态；不要重复发布或切换。
2. 由所有者在现有真实微信会话发送两条金额不同的全新消息，不先 reset。第一条已请求、尚待回应；逐条核对唯一交易、正确金额及成功后回执，并由所有者现场确认第二条没有复用上一条回执。
3. 完成后只删除精确识别的本次验收记录，复核账户/分类/交易三个哈希恢复基线。不得自动重放故障期间旧消息，不得修改未知交易，也不得以本次修复为由改账或补账。
4. 更新本交接、README 与 WINDOWS-HANDOFF 的实际微信验收结果。平台同一 message ID 的真实重放仍须单独证据；在缺少触发入口时继续明确列为未完成。

后续更新继续按 [运维手册](../ledger-cloudflare-runbook.md) 执行：新建发布要求 Git 源干净且 HEAD 不变，已发布版本的切换必须指定 `-ExistingReleasePath` 并重新验证 immutable release，不能覆盖现有目录。

此前 Ledger 公网、真实 Windows 重启、作品集和 HTTP 汇总证据保留在 [GPT-6 续接点](2026-09-05-secure-ledger-tunnel-gpt6-handoff.md)。MCP 仍未启用，不属于本次修复的默认步骤。
