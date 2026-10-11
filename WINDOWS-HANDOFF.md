# Windows 运行与交接：微信账本助理

2026-10-11 Mac 发布 `0f4114f`：共享图片工具和脱敏识图提示改为 AI 语义校验金额/币种、消费日期、用途；缺日期先询问，不再用收图日期补齐；没有币种信息则按用户指定默认 SGD。Windows 继续使用同一共享规则和原生入口，未重新启用退役实例，也未声称本轮 Windows 原生验收。Mac 已完成正式部署；场景及结果见 [100 组图片测试](test-cases/image-semantic/README.md)。

2026-10-04 Mac runtime、guard、宿主与看板已发布为 `f5f1934`：共享金额核验支持加、减、乘、除，数字间 `/` 或 `／` 必须先拟单确认；备注分隔符、原币、确认与去重保护保留。1081 项便携回归、427 项固定 ARM64 测试及 29 项实际模型用例通过；当前九卷备份、原数据保留及在线检查通过。手机新消息和 Windows 原生执行未重新验收，退役实例保持停止。见 [四则运算发布记录](docs/handoffs/2026-10-04-arithmetic.md)。以下按日期保留历史发布证据。

2026-10-03 分类显示调整：当前 Mac 账本的 45 个二级分类已配置 45 个不同的内置图标，41 项替换、4 项保留。分类结构、颜色、账户和现有 API 交易记录核对一致；本轮仅更新账本设置，未发布代码或重新启用 Windows。对应表适用于固定 ezBookkeeping 1.6.1，但未在退役 Windows 实例执行，旧隔离测试初始化行为保持。见 [图标方案与核对记录](docs/handoffs/2026-10-03-category-icons.md)。

2026-10-03 Mac 存储检查修复已上线：明确的短暂测量失败使用有界复检与可恢复暂停；硬错误、现有故障锁和数据保护保留。当前九卷备份、对账及在线验收通过，宿主／看板为基于 `0b92fc5` 的已核验代码快照，runtime/guard 仍为 `2729462`。Windows 退役状态和跨平台契约保持，未重新验收 Windows 原生执行；见 [调查与上线记录](docs/handoffs/2026-10-03-storage-observation.md)。

2026-10-01 图片证据修复：当时 Mac runtime、guard、host、看板为 `2729462`。已修正币种表达及实付款误拒，并让前置识图保留完整订单日期和秒数；Windows 脱敏配置模板同步该提取契约。964 项便携回归、171 项固定 ARM64 图片与回执测试通过；最终四张原图入账及四次重复发送共 8/8 通过。当前九卷备份 11,942 项独立恢复通过，全部原交易和历史回执保留；手机新回执与 Windows 原生执行尚未验收。见 [原因、原图验证与发布记录](docs/handoffs/2026-10-01-image-evidence.md)。下列为此前发布记录。

2026-10-01 删账重发修复：Mac runtime、guard、host、看板为 `be4441f`。图片新消息先核查原交易，明确删除后解除对应图片关联；存在则防重，查询失败则停止。原消息、永久确认和全部历史记录保持。961 项便携回归通过、1 项原有跳过，固定 ARM64 Docker 测试 215 项及独立账本实际删除重记通过；Windows 原生运行与本次手机重发回执仍待验证。见 [修复发布记录](docs/handoffs/2026-10-01-image-reentry.md)。

2026-10-01 时间补充：Mac runtime、guard、host、看板已更新至 `efc581d`。付款、下单、订单创建时间均可入账，优先付款时间，排除物流时间；支持常见日期格式及秒数，缺少日期或钟点时明确说明回退来源。955 项便携回归通过、1 项原有跳过，固定 Docker 测试 164 项通过；实际模型覆盖日期、秒数及确认后写入。共享接口不变，Windows 原生执行仍待验证；见 [时间规则与验收](docs/handoffs/2026-10-01-image-time.md)。

2026-10-01：图片记账已随 `54041e5` 上线至 Mac，runtime、guard、host 与重新绑定的看板均为该提交。共享插件支持明确实付款直接入账、歧义编号确认、十分钟有效期和图片防重；回执库仅增加两张图片表。952 项便携回归、26 项微信插件测试、161 项固定 Docker 回执与图片测试通过；四张私有原图及候选流程经过实际模型验证。未在 Windows 原生运行环境重新验收，也未启用已退役的 Windows 实例。生产保留与手机验收边界见 [上线记录](docs/handoffs/2026-10-01-image-bookkeeping.md)。

2026-09-30：共享插件修复查询参数错误后重试成功却回复失败的问题；Mac runtime、guard、host 与重新绑定的看板发布为 `701f3b3`。同晚 Docker 超时导致的保护停机已通过当前九卷备份、独立恢复和对账后恢复。原有交易、网页修改与永久去重记录保留，Windows 未重新启用。945 项便携测试和固定 Docker 中 154 项回执测试通过；Windows 原生运行及本次真实手机验收另行记录。见 [修复记录](docs/handoffs/2026-09-30-query-retry-repair.md)。

2026-09-27：Mac Docker 状态查询超时，缺失的存储样本触发保护停机。当前九卷备份、独立恢复和两库审核完成，19:02 服务及微信轮询恢复，模型实际调用与公网检查通过；原有 195 条交易与既有回执、确认去重记录保留。未发布代码、改动微信绑定或重新启用 Windows；底层卡顿原因和控制器策略仍待另行处理。见 [恢复记录](docs/handoffs/2026-09-27-docker-timeout-recovery.md)。

2026-09-21 运行记录：Mac 已启用有容量上限的状态采样、错误事件和故障前快照，看板“运行详情”显示记录状态。仅更新 Mac 宿主观察程序和看板，业务容器、数据、停机保护策略及 Windows 部署接口不变。见 [运行诊断说明](docs/mac-runtime-diagnostics.md)。

2026-09-21：Mac 存储采样失败触发保护停机，已完成当前九卷备份、两库审核和受审恢复。18:26 服务恢复，微信轮询、模型与公网检查通过；原有 184 条交易保持原样，上线后另有一笔真实微信记账与成功回执对应。恢复时运行版本不变，Windows 未重新启用；原始故障原因仍未知，后续已增加运行诊断记录，停机保护策略不变。见 [恢复与排查记录](docs/handoffs/2026-09-21-storage-check-recovery.md)。

2026-09-18 息屏补充：已验证显示器关闭时服务器继续运行，并安装独立的合盖息屏辅助任务；自动合盖触发待实际验收。用户反馈此前已正常合盖使用一天。见 [合盖息屏说明](docs/mac-lid-display-sleep.md)。

2026-09-18：Mac 合盖休眠后触发存储保护停机；当前九卷备份、两库核对及受审恢复完成，服务、模型与公网检查通过，全部交易及网页编辑保持原样。专用插电服务器已启用全局禁止睡眠，约六分钟合盖采样及独立公网检查通过，用户确认合盖正常且手机已收到回复；尚未验收整夜运行。Windows 未重新启用，本次 SSH 不可达。见 [故障恢复与合盖策略](docs/handoffs/2026-09-18-lid-sleep-recovery.md)。

2026-09-17：本机看板新增 iPhone 通知中转在线状态与历史手机验收日期；只读健康检查不等于实时手机送达。业务继续使用 `e9f94c0`，看板独立发布。见 [看板说明](docs/mac-production-dashboard.md)。

2026-09-16：Mac 微信试连第二个 ClawBot 实际替换了原绑定；已重新扫码并恢复账本授权与路由，全部既有数据保留，运行版本仍为 `e9f94c0`。服务、微信轮询、只读接口及公网检查通过；用户已确认手机查询正常返回历史记录。旧 Windows 接收器继续停用。见 [微信重连恢复记录](docs/handoffs/2026-09-16-weixin-rebind-recovery.md)。

2026-09-13 15:50：Mac 正式业务与看板已更新到 `e9f94c0`。修复授权到期后无法记账的问题；生产自动续期路径、续期后真实模型调用、微信轮询和公网验收通过。见 [授权修复上线记录](docs/handoffs/2026-09-13-oauth-expiry-repair.md)。

2026-09-11 安全收尾：`12879ae` 已提交公网限流模板和可选验收探针；没有本次 Cloudflare 规则启用、生产发布或线上验收的证据。推送代码不会自动更新不可变生产实例。后续步骤见 [安全交接](docs/handoffs/2026-09-11-public-security-checkpoint.md)。

项目继续维护 Windows 与 Mac 两条部署路线。本次停机只退役当前操作者的旧 Windows 实例；Windows 部署脚本、配置契约、测试与恢复接口保留，供公开发行及其他用户部署。

2026-09-13 较早发布：`d33bc21`，已修复口述小数与钟点混淆，当前健康、微信轮询、公网、首次中行取价和九卷备份恢复校验通过。旧 Windows 四项任务仍停止并禁用；原安装、快照和恢复资料保留。该轮事实以 [午饭修复记录](docs/handoffs/2026-09-13-spoken-decimal-fix.md) 为准；此前 Windows 副本恢复和真实微信写入是历史验收。

本文件保留 Windows 原生部署契约和操作入口；其中带日期的发布章节描述当时状态，不代表 Windows 仍在线。新部署从 [Windows 安装](#windows-安装) 开始，现有部署先检查实际服务身份。Mac 使用 [Docker 入口](deploy/docker/README.md)，不把 Linux wrapper 部署到 Windows。

## 2026-09-13 Mac 上线与消息用例

金额确认、多币种子账户、合并查询与每日中行现汇卖出价已随 `959e8f9` 部署至 Mac；159 种原币账户已创建，原有数据保持。新增 [统一 JSON 用例库](test-cases/wechat-bookkeeping.json)，当前 210 条，维护方法见 [用例说明](test-cases/README.md)。数据格式和静态校验可跨平台使用；当前实际模型批量入口仅在 Mac ARM64 隔离 Docker 上验收，不代表 Windows 原生或真实微信收发已验收。详见 [当日交接](docs/handoffs/2026-09-13-ambiguous-amount-confirmation.md)。

## 2026-09-07 Windows 历史发布：食堂编号修复已上线

当晚明确记账请求被拒绝的根因已定位：金额校验把 `Canteen` 名称中的编号当成第二个金额，再返回混淆金额与语气的通用拒绝文本。修复按原文识别食堂编号，保留小数、币种、多笔金额与疑问的原边界；金额校验失败单独说明未入账原因。正式 release `1ab154fca487154fb07def1be31ca44faaa7c4a7` 已发布并切换，38,397 份文件校验、切换后严格本机 14/14 与公网验收通过；Gateway、微信通道、原任务定义、六工具策略和历史去重记录均已核验。详见 [修复与上线记录](docs/handoffs/2026-09-07-numbered-canteen-fix.md)。未补写此前失败的交易，未进行新的真实微信端到端验收。

## 2026-09-07 较早发布：历史明细格式与系统复核

历史查询原始 JSON 的根因、回复来源保护、确认单与配置回滚修复集中见 [当时审计](docs/handoffs/2026-09-07-history-reply-audit.md)。该次正式 release 为 `3ed3f1bff5a7119d066f75df03d3f59f5fc0b76b`，完整文件校验、源码回归 841/841 和严格本机检查 14/14 通过。当时 workspace 已切换，原 Gateway 任务定义与六项工具权限保持一致。用户明确取消该次真实微信验收，不能把较早聊天验收记作该次结果。

同日较早排查确认，“中午吃饭7.1+2.5”曾因模型使用 `timeMode=received`、校验器却要求 explicit 而被拒绝；加法金额和疑问判断本身正常。按用户明确规则，“中午吃饭”“晚上吃饭”和“午饭”“晚饭”一样作为消费描述，没有另外写日期或具体钟点时统一按可信消息发送时间记账。日期、具体钟点、非 SGD 和真实疑问的边界继续保留。时间校验失败单独说明，不再误报成金额或语气不确定。此前发布 `1d561835030e880399252baad510cc58381e1eea` 的完整回归 768/768、本机检查 14/14 通过；当时的实际验收见下述系统检查记录。

较早的历史查询验收之后，00:59 和 01:01 的两次 `record_expense` 在可信消息绑定处失败。跨插件实例回归已复现并修复，当时完整回归 752/752 通过，并发布为 `c05813e16d5c87096dc379fc51c00fad648b0b94`；原 Gateway 任务定义保持一致，微信“记账→历史查询→再记账”和备注汇总通过。检查范围与验收结果见 [系统检查记录](docs/handoffs/2026-09-07-bookkeeping-system-audit.md)。以下日期章节保留当时状态，不代表当前版本。

## 2026-09-07 较早记录：历史查询已开通并通过微信验收

用户明确批准开通历史查询。已通过既有交互式脚本启用本机 MCP、生成独立令牌并核验 owner-only 文件权限；本地 MCP 握手和 `query_transactions` 工具发现通过。正式账本已恢复健康。生产插件及 workspace 继续使用 `1d487943433869d0422f1bf4446fd046717c3647` release。

00:55 的真实微信回合已加载六项工具并调用 `ezbookkeeping__query_transactions`；本机审计状态为 `succeeded`、无错误码，用户确认微信正常返回历史明细。

此前于 00:53 定位并修正了微信工具过滤问题：基础 `profile=minimal` 会先排除原生 MCP 工具。当前 bookkeeper 使用 `profile=full` 加六项精确 `allow`；实际 OpenClaw 策略的离线验证只放行这六项。配置已核验热加载，模板与相关策略测试 16/16 通过。不要只启用 MCP 服务而保留旧的 minimal profile。

开通过程修复了服务退出检查的竞态：端口或进程可能在两次探测之间正常退出；只有再次确认端口为空才接受退出，仍被占用或探测失败时继续拒绝。相关回归 22/22 通过，测试使用合成数据和模拟端口查询。

Gateway 的官方重启等待超时后，先用原有 `gateway.cmd` 隐藏恢复；随后按官方非交互方式停止已核验的临时实例，并从原有后台任务重新启动。RPC 和微信通道检查通过，临时实例已退出；未修改登录启动任务，本轮未验证 Windows 登录或整机重启。匿名公网 MCP 请求及用户另行明确授权的有效 MCP 令牌连接检查均核验为 IP 限制拒绝，真实微信历史查询已通过验收。完整范围与启动环境排障见 [历史查询开通记录](docs/handoffs/2026-09-07-history-query-activation.md)。

## 2026-09-06 补充：后台无窗口启动

正式账本、隔离测试账本和 Ledger Tunnel 已切换为当前账户、`S4U`、`Limited` 的计划任务；登录触发器、启动命令、工作目录、重启策略均保留。三项任务的实际进程已在 session 0 验证，正式和测试账本健康检查、公网登录页检查通过。OpenClaw 保留原有隐藏启动器，未切换 release 或修改其认证配置。

本轮未执行 Windows 整机重启，也没有发送新的微信测试消息；不要把任务重启与健康检查表述为这两项人工验收。操作边界、迁移与恢复说明见 [后台启动维护说明](docs/windows-background-startup.md)。

## 2026-09-06 续接点：金额查询已发布，微信只读验收通过

分支 `feat/amount-transaction-search` 从已同步的 `e3af81b` 创建。开发前，原在线 `summarize_expenses` 只支持时间、分类与备注筛选，没有金额参数；当时只读核验确认生产为 `0e7c2d7`，MCP 未启用、独立 MCP token 不存在，在线工具 allowlist 未含 `find_expenses`。这证明当时的能力缺口；其后的实际发布与查询验收见本节下文。

新工具 `find_expenses` 仅查固定的可见 SGD 日常支出账户：金额为十进制字符串，精确到整数分；默认全部历史，可指定今天、本周、本月、上月、今年或自定义日期，默认 3 笔、上限 10 笔。HTTP `transactions/list.json` 请求 `type=3`、精确 `account_ids`、`amount_filter=eq:<minor>`、`count=limit+1`、`page=1`，不请求总数，不遍历后续页。全部历史显式 `max_time=0`；日期边界使用新加坡时间转换后的交易序列 `min_time=startTime*1000`、`max_time=endTime*1000+999`，不能把秒直接传给这两个参数。契约依据 [查询模型](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/models/transaction.go#L400-L432) 与 [时间序列转换](https://github.com/mayswind/ezbookkeeping/blob/v1.6.1/pkg/utils/datetimes.go#L392-L403)。

返回条目须逐笔验证类型、账户、精确金额、日期范围和唯一 ID，并按时间序列从新到旧展示；只输出必要日期、金额、分类和备注，不输出原始对象或业务 ID。有后续游标或多取到一条时明确仍有更多；失败及不完整分页不得显示“没有记录”。所有测试使用 fake fetch 和临时合成数据，没有查询或写入生产交易，也未读取 `testAccountInfo.txt`。

微信查询在有当前绑定或可信执行上下文时领取持久消息关联，并在工具执行时保存成功或固定失败回执，供独立发送实例恢复；不依赖同实例的 `after_tool_call`，也不复用旧查询缓存。发布器固定清单已包含新模块；校验器在校验全部文件哈希后，仅对声明 `find_expenses` 的插件要求该模块，保留旧发布包作为回滚目标的兼容性。

分支实现完成 TDD 与独立代码审查；新增金额查询相关测试 91/91，整套 bookkeeping 回归 625/625 通过（失败、跳过、取消均 0）。发布脚本独立回归 55/55 通过，两个修改的脚本均通过 PS 5.1 解析。这些是合成验证，不代替新工具发布后的真实微信只读验收。

用户随后明确批准上线。当前生产 release 为 `1d487943433869d0422f1bf4446fd046717c3647`，发布包 38,396 个文件的哈希与 ACL 校验通过。既有 publisher 完成 release 切换；受限备份与官方 config patch 仅向 `tools.allow` 末尾追加 `find_expenses`，预演、配置完整比对及 Gateway 重启后检查通过。模型、所有者白名单和其他配置保持原合同；临时 patch 已清理，备份留在仓库及 OneDrive 外。

新 release 的严格本机验收 14/14、带 API token 的公网检查及作品集基线比较通过；Gateway/channel/plugin/Codex/model 通过，当前 Gateway 启动实际注册一个 managed session-memory hook，文件哈希与仓库一致，没有 loader 失败。新包与旧 `0e7c2d7` 均通过完整 verifier，旧包保留。MCP 保持关闭；未改变 Tunnel、DNS 或规则。

用户微信只发送一次“帮我查一下账本里有没有3.36的账”，确认只有一条正常回复、显示 1 笔 3.36 SGD。已发布 adapter 的只读查询返回相同匹配数量，查询前后账户、分类、交易三个规范化哈希及 formatter 摘要均未变；本次没有写入或清理测试交易。详细证据范围见 [金额查询发布交接](docs/handoffs/2026-09-06-amount-search-release.md)。此前同 message ID 的真实平台重放缺口继续保留，`deploymentComplete=false`。

回滚金额功能时必须恢复合适的完整受限配置备份，或用同样严格的配置 patch 移除 `find_expenses`；随后核对路径，并通过 publisher 切换旧 release 和复验。权限 patch 前的备份制作于新包切换之后，单独恢复它只回退权限，不能回退代码。仅切旧 release 路径则会保留新工具的 allowlist 项。Git 文档更新或合并不自动改变上述生产 release。

## 2026-09-05 续接点：旧回执双消息验收通过，平台重放仍待验证

本次故障、修复及待办见 [微信旧回执修复交接](docs/handoffs/2026-09-05-wechat-stale-reply-repair.md)；此前 Tunnel、重启和验收证据见 [GPT-6 续接点](docs/handoffs/2026-09-05-secure-ledger-tunnel-gpt6-handoff.md)。生产 `bookkeeper` 继续固定为 `gpt-5.6-sol` 与官方 Codex harness。

- 用户已明确授权全量 neat、推送、提 PR、合并 `main`、清理无用分支及同步远近端。删除旧分支/worktree 前必须核对无独有提交、未提交文件、运行依赖或活动任务，不得 reset、rebase 或丢弃工作。Git 合并不切换生产代码。
- 两次新微信消息重复收到上一笔回执，已确认运行中的旧 release `1cf2f739ca92898feed5f24372e9a407ced34b0a` 未部署 `93543ab` 的新可信消息优先修复。新增 `c5e2e25` 拒绝多候选和错误确认决定触发的旧成功回执回退，回复回归 516/516 通过；`48225a1` 仅修正测试中的 Windows CRLF 兼容。
- `0e7c2d7f1f0369552d17d054e2ef24b75be7a482` 包含 managed `session-memory` 保护，完整 `npm test` 退出码为 0，独立 hook 测试 14/14。新 release 已发布且 verifier 通过，现已返回 `OPENCLAW_RELEASE_SWITCHED`、退出码 0；脚本中的 Gateway/channel/plugin/Codex/model 检查通过。切换后 workspace 和两条 plugin 路径均为新 release，正式 `8888` 的 loopback、唯一 owner、程序与配置正确，Gateway loopback 恢复。修正仓库 `.ps1` 的 CRLF/LF 约定后，严格本机重验 14/14 全部通过、退出码 0；已部署 Tunnel 脚本未变，verifier 未放宽。
- 旧 release 的 PS 5.1 全量 verifier 已返回 `ROLLBACK_RELEASE_VERIFIED`、退出码 0，保留用于回滚。同次维护在切换前运行了带 `ApiTokenPath` 与 `ComparePortfolioBaseline` 的公网验收，返回 `LEDGER_PUBLIC_ACCEPTANCE_OK`；本次没有额外重跑限速验证。两条全新微信消息的现场验收已通过，平台同一 message ID 重放仍未验证，不能据此宣称全部上线通过。
- managed hook 三个文件已安装，direct import 验证通过；Gateway 启动 INFO 的实际 `loadedCount=1`，配置与 eligibility 均为 1 且唯一条目为 managed `session-memory`，loader 失败数为 0，已证明运行注册成功。只跳过 `context.agentId === 'bookkeeper'`；`main` 及其他代理保持官方处理。官方上游固定 OpenClaw 2026.8.2 与 handler/descriptor 双 SHA-256，升级时须先审核再更新 pin。
- 旧 workspace 的四个 memory 文件已迁至仓库外受限归档，迁出前后哈希 4/4 一致；未读取正文，未删除文件。修复与代码切换未补账或重放此前业务消息，仅按验收流程创建并精确清理两个已知测试交易。
- 双消息验收在同一既有微信会话中完成，未 reset：两条全新可信消息分别为 0.01、0.02 SGD，各自对应唯一成功 receipt 和 API transaction，message key、clientSessionId、transaction ID 均独立。用户确认第一条正确，第二条未重复第一条回执。
- 两个已知测试交易已精确删除，两次 API 响应均严格满足 `success=true`、`result=true`；删除后两 ID 与标记均消失，交易数减少 2。相对于此次删除前快照，非目标交易与分类完全未变，目标独立账户余额仅增加 3 minor（0.03 SGD），完整预期账户状态吻合。
- 原始发消息前的账户/分类/交易三哈希基线因测试标记实际大小写差异，未能由旧进程完成比较，不能报告原三哈希恢复。新核验对 ASCII 标记精确不分大小写定位，随后对实际原文、金额、ID 和完整目标内容哈希严格复核；未修改测试正文，未修改未知交易。
- 正式 `127.0.0.1:8888`、隔离测试 `127.0.0.1:18888`、immutable OpenClaw release、受控 Tunnel、Ledger DNS 与五条规则已部署，此前本机验收 14/14 通过；续接先只读复核，保留既有资源。
- 此前正式网页登录及一次性记录的新增、显示、修改、删除已完成；该次仅删除已知验收记录，账户/分类/交易三个规范化哈希全部恢复基线。这是历史验收结果，不能代替本次清理的比较范围。凭据未写入本地文件。
- pre-HSTS 闸门通过后，仅给现有 Ledger header rule 添加 `Strict-Transport-Security: max-age=86400`，无 `includeSubDomains` 或 `preload`。随后完整公网限速/token/缓存/安全头、作品集回归和 Cloudflare 只读 22/22 通过。
- `ServiceCycle` 与恢复验证通过，包括 origin 停止及错误端口 owner 时 Tunnel 失败关闭。用户已执行真实 Windows 重启，启动时间严格晚于 owner-only `ledger-reboot-v1.json` 基线；12:56 UTC 的 `VerifyPostReboot` 完整通过，本机、公网、作品集和 OpenClaw 均恢复。原基线保留，不要覆盖。
- 此前整合提交 `bedefb0` 的完整测试 513/513、stable-ID build 与 3/3、15 个 PowerShell 5.1 脚本解析全部通过；这些历史结果不能替代本次修复后的现场验收。
- 此前单条微信记账与 HTTP 标记筛选汇总验收通过，只删除已知测试记录后三个哈希恢复原基线；本次故障说明单条测试不足以覆盖跨轮旧回执问题，现已补充并通过连续两条新消息验收。
- 项目目前没有真实平台同 message ID 重放入口，该项仍需独立真实证据；重复发送同正文、插件合成测试、单条 created 去重状态均不能代替。回复条数来自用户现场观察，不能把已删除的待回复状态当作发送次数证据。MCP 仍关闭，不是本轮默认启用步骤。
- 根目录可能存在被 Git 忽略的 `testAccountInfo.txt`。不得读取到终端输出、模型上下文或 Git；它只可由不回显的本机流程用于 `18888` 测试登录，不能代替正式网页登录凭据。

PR #5 当时已合并至 `main` 的 `5c128bb`，当时生产为 `0e7c2d7f1f0369552d17d054e2ef24b75be7a482`，该次验收文档更新无须重新部署；当前生产版本与验收范围见顶部记账交叉故障检查续接点。PR 合并与清理完成以联网核对本地 `main`、upstream、远端 `main` 一致，目标提交均在其历史中且工作区干净为准。新会话先按本次修复交接只读核验 active release、hook 注册和服务状态；双新消息验收与已知测试交易清理已完成，但不能称原始发消息前三哈希恢复。真实平台同一 message ID 重放仍未验证，`deploymentComplete=false`。

## 不变边界

- Windows 是唯一在线接收端，原 Mac 接收端已停止。不要让两台 iLink Gateway 同时轮询。
- 微信消息经腾讯 iLink 进入 Windows OpenClaw；专用 `bookkeeper` 使用 OpenAI GPT-5.6 Sol，并强制走官方 Codex harness。该云端处理已获用户明确授权。
- OpenClaw Gateway 固定绑定 `127.0.0.1:18789`；正式 ezBookkeeping 固定 `127.0.0.1:8888` 且 UUID server ID 为 `0`，隔离测试实例固定 `127.0.0.1:18888` 且 UUID server ID 为 `1`。
- 网页只通过 `ledger.66ccff-labs.com -> Cloudflare Tunnel -> 127.0.0.1:8888`；不开放公网/LAN origin 端口，不部署到账本 Vercel，不启用 Cloudflare Access。
- `66ccff-labs.com` 和 `www.66ccff-labs.com` 继续进入原作品集，Ledger 上线不得改写其 DNS、路由、redirect、cache、HSTS 或部署。
- 不提交或转发密码、API token、MCP token、Cloudflare 身份/凭据、微信账户 ID、发送者 ID、二维码、会话正文、SQLite、交易、日志或 OpenClaw 状态。
- 正式 OpenClaw 只加载仓库外的 hash-verified immutable release；仓库自动化与集成测试不得访问 `8888`。

## 发布架构

```text
WeChat -> OpenClaw immutable release -> owner-bound OpenAI GPT-5.6 Sol (official Codex harness)
  -> record_expense | prepare_expense | resolve_expense_confirmation
     -> trusted write/confirmation adapter -> 127.0.0.1:8888 ezBookkeeping HTTP API
  -> summarize_expenses | find_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
     (local MCP enabled; live WeChat query verified)

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

兼容基线为 OpenClaw 2026.8.2、官方 `@openclaw/codex` 2026.8.2、OpenAI `gpt-5.6-sol`（ChatGPT OAuth、thinking low）和 ezBookkeeping 1.6.1。旧版配置账户固定为 SGD `日常支出`；2026-09-13 起 Mac 已部署经过验证的 159 种原币子账户，查询覆盖旧账户及新子账户，未声明币种仍默认 SGD。回执账本名固定为 `日常账本`。专用模型以 `agentRuntime.id: codex` fail closed，不配置 Qwen 或其他模型后备。确定性 HTTP 汇总已上线；原生 MCP 的实时启用状态与独立 token 必须在本机探测，不能由代码存在推断。

专用代理的最终 allowlist 恰好是：

```text
record_expense
prepare_expense
resolve_expense_confirmation
summarize_expenses
ezbookkeeping__query_transactions
find_expenses
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

Codex 负责判断语义。明确表达已发生消费且包含明确金额时调用一次 `record_expense`；候选信息完整但仍带疑问或不确定语气时调用一次 `prepare_expense`。每条消息最多写一笔；`6.5+2.5` 是一笔合计 9，不是两笔。两个工具都要求显式提供已确定的 ISO `currency`（未声明币种的文字使用 SGD）和时间决策 `timeMode`：没有指定日期或钟点用 `received`，有日期或钟点用 `explicit`。“中午吃饭”“晚上吃饭”和“午饭”“晚饭”一样作为消费描述，直接按消息发送时间记账。

1. OpenClaw 将所有者微信消息路由给专用代理。
2. 插件按 session 或 `channel + sender` 找到十分钟内的可信原始消息。
3. 插件以可信 `channel + messageId` 生成持久去重键；消息正文相同但 ID 不同仍是两笔独立请求。
4. 在最终工具权限确定后，插件只向已关联的 owner 记账轮注入可信微信发送时间；上下文不含 sender、message ID、token 或其他身份值。
5. 模型先在内部提取消费时间、金额、币种、正式一级/二级分类和可选语义备注。`explicit` 还要提供 `localDate`、原文 `timeEvidence`，并只在具体钟点明确时提供 `localTime`。
6. 插件校验原文证据、日历值、币种、金额与未来时间边界。无时间表达使用可信发送时间；只有日期则替换日期并保留发送时分；日期和具体钟点都有则使用精确消费时间。
7. 最终消费时间规范为 Unix 秒后提交给 ezBookkeeping；输入若是毫秒则先除以 1000，API `time` 与权威回执必须来自同一个值。
8. 插件使用 API token 调用本机 HTTP API。只有 API 明确返回交易 ID，才允许成功回执。

Mac 已部署版本支持全部 159 币种；Windows 原生路线保留同一源码能力，部署前需独立验收，按原币写入对应子账户；文字和图片均在未写币种时默认 SGD，图片回执说明默认；明确原币保留，冲突先澄清。旧 SGD 账户与历史保留，完整查询同时覆盖旧账户和新子账户。最终消费时间可早于发送时间；若晚于发送时间超过 5 分钟，则在认领消息和调用 API 前拒绝。

### 图片输入

单张 JPEG、PNG、WebP（最多 10 MiB）由接收插件关联当前可信消息和受控附件，官方模型提取实付款、币种、状态和商品摘要。AI 判断单笔已发生支出、金额和日期及用途齐全时直接入账，不要求固定日期或付款标签；缺日期或用途先询问，有完整合理候选时才编号确认。每会话最多十笔、十分钟有效，回复“确认第3笔”或“取消第3笔”；普通查询不清除图片候选。重发图片时先查询原账目，仍存在则防重；接口明确确认已删除，才允许按新消息重新入账。查询失败时明确说明并停止，原消息与确认消息的永久防重记录保留。

付款、下单、订单创建时间都可入账，优先付款时间，排除发货、收货、预计到货和手机状态栏时间。图片中的日期与秒数保留；缺日期先询问；只有日期但缺钟点时采用原图收到时分并说明，不能改用确认消息时间。回执库新增 `image_expense_links` 和 `image_expense_proposals`，升级保留整个数据库。规则和复验入口见 [图片设计](docs/superpowers/specs/2026-10-01-image-bookkeeping-design.md) 与 [用例说明](test-cases/README.md)。Mac 已上线，Windows 原生媒体链路仍需独立验收。

币种和付款依据不要求固定表达或语序。中国电商上下文与 ¥ 可支持人民币；支付方式本身不能证明已付。实际小票、卡片及订单上下文可支持已发生消费，不要求实付款标签；未付或退款状态仍拒绝新增支出。校验失败分别说明币种、总额或付款状态问题，详见 [图片证据修复](docs/handoffs/2026-10-01-image-evidence.md)。

### 文字对话确认

2026-09-13 已在 Mac 部署：多个可疑金额先由 OpenClaw 的既有 AI 按语义选择最可能的实付金额，再调用 `prepare_expense` 发完整确认单。插件要求候选出自当前可信消息中的完整金额或明确算式结果（2026-10-04 扩展为四则运算），但拟单不再要求唯一金额。误调用 `record_expense` 时，若金额有依据却不唯一，也降为确认单，绝不直接写账。`F1` 商品描述与件数不会妨碍正常价格识别。没有候选、虚构金额、把数量／日期／原价／余额当成实付，仍不能拟单。模型与六工具权限未变，原回执数据库结构不变。新增多币种与每日汇率缓存见下文。见 [本次交接](docs/handoffs/2026-09-13-ambiguous-amount-confirmation.md)。

文字路径的 `prepare_expense` 只校验并保存候选支出，不访问 ezBookkeeping；图片路径可只读核查旧交易，但拟单不写入账本。待确认提案按所有者会话哈希存入同一个本地 SQLite 状态库，十分钟过期，每个会话最多一张。确认单包含账本、金额、分类、备注和已解析消费时间；提案同时保存结构化时间字段与最终 Unix 时间戳。

用户随后单独回复“是”“是的”“好的”“没问题”“行”“记入”“确认”“对的”等简短确认词时，`resolve_expense_confirmation` 原子取出提案并走同一套账户、分类、去重、API 写入和终态处理；单独回复“不是”“取消”“不记”“不要”“撤销”“忽略”“拉倒”等则只删除待确认提案，不删除已入账交易。两侧均按整条消息匹配，可带句尾句号、感叹号、逗号或波浪号；具体词表由工具说明从运行时代码生成。带问号、金额修改或其他实质内容的消息不直接作为确认。确认时重新核对结构化字段和已保存时间戳，但绝不按确认消息时间重新解释。重复确认、过期确认和没有待确认提案的确认都不会写入。

如果等待文字确认期间收到其他实质新消息，插件会先废弃旧文字提案，再让 Codex 正常处理新请求；`不是，是8.2` 因此按新消息处理，而不是误用旧提案。确认词与工具参数不一致时不会消费提案。

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

`ezbookkeeping__query_transactions` 用于“最近三笔是什么”“上周在 NTUC 买过什么”等逐笔问题。本机 MCP 已在 2026-09-07 激活。专用代理的工具调用 hook 将查询限定为配置的支出账户、`type=expense`，默认 3 条、最多 10 条，并补齐展示所需字段；这是插件调用路径的限制，不改变原生 MCP 服务本身。返回后核验金额、币种、账户、时间及分页完整性，再生成编号明细；错误和原始 JSON 均不直接发送。交易备注始终是不可信数据，不能触发任何工具。

历史查询的来源与规范化参数通过独立的 SQLite handoff 交给结果 hook，格式化回复再进入持久化发送流程；不要恢复仅依赖内存 Map 或要求所有工具结果一律逐字发送的旧做法。`latest_recipient_messages`、`latest_substantive_messages`、`real_inbound_message_history` 和 `pending_authoritative_replies.source_message_key` 共同防止旧回复替换新请求及迟到确认单复活。迁移键 `trusted-inbound-freshness-v1` 与原迁移记录必须保留。

一条消息同时明确要求记账和查询时，只执行一次写入并原样返回其结果，本轮不读取；用户另发一条消息查询。

## owner-only MCP

`clawbot-bookkeeping` 已为 `ezbookkeeping` 实现 requester-scoped connection resolver；本机服务已于 2026-09-07 激活。只有同时满足以下条件时才返回连接：

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

只有看到 `STATIC_EZBOOKKEEPING_MCP_FALLBACK_ABSENT` 才能继续。若检查失败或发现该属性，停止部署；不要显示其内容，也不要自动删除，必须另开一次有审核的移除操作。此断言与 manifest/resolver/allowlist 自动化测试证明没有静态后备连接；MCP 已激活时，再由所有者微信历史查询证明动态连接可用。

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

bookkeeper 使用 `tools.profile=full` 和六项精确 `tools.allow`；后者限制实际工具范围。不要改回 minimal profile，它会在精确 allowlist 生效前过滤掉原生 MCP 工具。MCP 使用独立服务和令牌，本机已完成启用；这里不依赖工具搜索。Codex Code Mode 仍可在 `exec` 中调用已经直接加载的 `tools.<账本工具>`；不得查询 `ALL_TOOLS` 或搜索工具目录。包装返回字符串时原样输出完整字符串。工具返回文本是最终账本事实；模型不得自行重建回执。设置后须核验 Gateway 已热加载对应字段，否则重启并复查。

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

### 2. 可选：启用 MCP 并生成独立 token

本机已于 2026-09-07 在用户明确授权后完成本节。以下步骤用于新的部署或经授权的恢复；不要在正常运行时重复生成令牌。

先预演；此步骤不得修改任何状态，也不会询问密码：

```powershell
.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
```

再在用户可见的 PowerShell 中实际执行，由用户在安全提示中输入 ezBookkeeping 密码：

若从 Codex 或 PowerShell 7 通过 `Start-Process` 打开 Windows PowerShell 5.1，继承的 `PSModulePath` 可能使 `Set-Acl` 错误加载其他版本的安全模块。应在新进程中先显式导入本机模块：`Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop`。无需移动仓库或改动全局模块路径。

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

先确认 ezBookkeeping 与 Gateway 健康；MCP 只在用户已明确选择激活后额外验收：

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
- 所有者从微信发起支持的确定性 HTTP 汇总，证明读取正常且不写入；仅在 MCP 已激活后，再用真实历史查询证明 `query_transactions` 在可信发送者上下文中可用。

动态 MCP 由插件 manifest 和 requester-scoped resolver 声明，故意不配置顶层 `mcp.servers` 静态连接。第一版不使用 operator CLI 证明该动态连接；部署前属性名断言证明没有静态 `ezbookkeeping` 后备项，插件加载结果和自动化策略测试证明动态声明与最小工具目录。MCP 未激活时记录为未启用，不生成 token；激活后才由所有者微信历史查询证明可信上下文中的实际连接。

如 ezBookkeeping 不健康，先以只读方式核验任务动作和端口 owner。安装脚本不会替换漂移任务；不要由模型启动服务，也不要直接重启未经验证的同名任务：

```powershell
$ErrorActionPreference = 'Stop'
try {
    .\scripts\install-ezbookkeeping-task.ps1 -WhatIf
    $null = .\scripts\install-ezbookkeeping-task.ps1
    . .\scripts\ledger-runtime-common.ps1

    $installDirectory = 'D:\Clawbot\ezbookkeeping'
    $configPath = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini'
    $executable = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.exe'
    $task = Get-LedgerExpectedTask `
        -TaskName 'Clawbot ezBookkeeping' `
        -InstallDirectory $installDirectory `
        -ExpectedExecutable $executable `
        -ConfigPath $configPath `
        -Mode Explicit
    if ([string]$task.State -ne 'Running') {
        if (@(Get-NetTCPConnection -State Listen -LocalPort 8888 -ErrorAction SilentlyContinue).Count -ne 0) {
            throw 'Port 8888 is already occupied; the validated task was not started.'
        }
        Start-ScheduledTask -InputObject $task -ErrorAction Stop
    }
    Start-Sleep -Seconds 2
    $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $executable -ExpectedConfigPath $configPath
    $health = Invoke-RestMethod http://127.0.0.1:8888/healthz.json -MaximumRedirection 0 -TimeoutSec 10
    if ($health.success -ne $true) { throw 'ezBookkeeping health validation failed.' }
} catch {
    throw 'The exact production task could not be validated and started safely.'
}
```

重新运行安装脚本只会创建缺失任务或确认既有动作完全一致；任何漂移都失败关闭。不要删除或覆盖冲突任务来绕过检查。

若配置 MCP 失败且自动回滚失败，使用错误中记录的 `before-mcp` 备份恢复 `conf\ezbookkeeping.ini`，再重启同一个已核验任务。不要停止其他路径或名称碰巧相同的进程。

## 仓库验证

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test/*.test.mjs
```

账本插件当前完整测试必须零失败，stable-ID 插件 build 与全部 `test/*.test.mjs` 必须通过；覆盖项还包括 runtime 隔离、release 完整性、Tunnel fail-closed 与公网规则范围。不要只依赖数量，任何失败都必须处理。

从仓库根目录执行以下 tracked-only 扫描。先检查 Git 路径清单，禁止路径、符号链接或 junction 都在读取内容前失败关闭；不扫描未跟踪或被忽略文件。stable-ID 的 `src/storage` 是源码目录，仅允许已核验的 `state-dir`、`sync-buf` 两个模块及各自的 JS/source map；这六个文件仍接受正文扫描。`testAccountInfo.txt` 只可另外检查是否存在及是否被 Git 忽略，绝不读取内容。结果只含文件、行号、规则名和计数，不输出匹配正文：

```powershell
$ErrorActionPreference = 'Stop'
$ledgerScanRoot = (Get-Location).ProviderPath.TrimEnd('\')
$ledgerScanLines = $null
try {
    $ledgerTrackedOutput = & git -c "safe.directory=$ledgerScanRoot" -C $ledgerScanRoot ls-files -z
    if ($LASTEXITCODE -ne 0) { throw 'TRACKED_FILE_LIST_FAILED' }
    $ledgerTrackedPaths = @(($ledgerTrackedOutput -join "`n").Split([char]0) | Where-Object { $_.Length -gt 0 })
    if ($ledgerTrackedPaths.Count -eq 0) { throw 'TRACKED_FILE_LIST_EMPTY' }
    $ledgerForbiddenPath = '(?i)(^|/)(testAccountInfo\.txt|\.git|\.worktrees|\.openclaw|\.cloudflared|node_modules|backups|deployment-evidence|logs|secrets|data|storage)(/|$)|(^|/)\.env($|\.)|\.(db3?|sqlite3?)(-|$)|\.log($|\.)|\.(pem|key|p12|pfx|secret)$|^openclaw-workspace/memory/|^config/cloudflared-ledger\.(yml|credentials\.json)$'
    $ledgerSourceStoragePath = '^openclaw-plugins/openclaw-weixin-stable-id/(src/storage/(state-dir|sync-buf)\.ts|dist/src/storage/(state-dir|sync-buf)\.js(\.map)?)$'
    foreach ($ledgerRelativePath in $ledgerTrackedPaths) {
        if (($ledgerRelativePath -match $ledgerForbiddenPath -and $ledgerRelativePath -cnotmatch $ledgerSourceStoragePath) -or $ledgerRelativePath -match '(^|/)\.\.(/|$)|[\r\n]') { throw 'FORBIDDEN_TRACKED_PATH' }
        $ledgerFullPath = [IO.Path]::GetFullPath((Join-Path $ledgerScanRoot $ledgerRelativePath))
        if (-not $ledgerFullPath.StartsWith($ledgerScanRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTSIDE_REPOSITORY_PATH' }
        for ($ledgerProbePath = $ledgerFullPath; $ledgerProbePath -ine $ledgerScanRoot; $ledgerProbePath = [IO.Path]::GetDirectoryName($ledgerProbePath)) {
            if ((Get-Item -LiteralPath $ledgerProbePath -Force).LinkType -in @('SymbolicLink', 'Junction')) { throw 'LINKED_TRACKED_PATH' }
        }
    }
    $ledgerScanRules = [ordered]@{
        bearer = 'Bearer\s+[A-Za-z0-9._-]{20,}'
        wechat_identity = 'openclaw-weixin:[A-Za-z0-9_-]{8,}'
        password_literal = '(?i)password\s*[:=]\s*["''][^<][^"'']{7,}["'']'
    }
    $ledgerFindings = @(foreach ($ledgerRelativePath in $ledgerTrackedPaths) {
        $ledgerScanLines = [IO.File]::ReadAllLines((Join-Path $ledgerScanRoot $ledgerRelativePath), [Text.Encoding]::UTF8)
        for ($ledgerLineIndex = 0; $ledgerLineIndex -lt $ledgerScanLines.Length; $ledgerLineIndex++) {
            foreach ($ledgerRuleName in $ledgerScanRules.Keys) {
                if ([regex]::IsMatch($ledgerScanLines[$ledgerLineIndex], $ledgerScanRules[$ledgerRuleName])) {
                    [pscustomobject]@{ File = $ledgerRelativePath; Line = $ledgerLineIndex + 1; Rule = $ledgerRuleName }
                }
            }
        }
        $ledgerScanLines = $null
    })
    [pscustomobject]@{ ScannedFiles = $ledgerTrackedPaths.Count; FindingCount = $ledgerFindings.Count; Findings = $ledgerFindings } | ConvertTo-Json -Depth 4
} catch {
    throw 'TRACKED_SECRET_SCAN_FAILED; no matched content was emitted.'
} finally {
    $ledgerScanLines = $null
}
```

测试、示例、脚本和文档都必须包含在 tracked 清单中；禁止路径一旦被跟踪，应先处理该异常，不能跳过后继续宣布扫描通过。上述模式只是初筛，零命中不能独自证明没有秘密。每个命中都需核对是否为固定合成 fixture 或占位符；检查过程只返回脱敏结论，不把命中正文送入终端或模型上下文。无法证明为合成数据的命中必须停止发布并处理，不能为了零匹配扩大忽略范围。

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

- 汇总或历史读取失败：`账本暂时连不上，这次没有读取任何数据～ 稍后再试试吧。`
- 写入在提交前失败：`账本暂时连不上，这次没有写入任何数据～ 稍后再试试吧。`
- 写入请求已提交但结果不确定：`记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。`
- 期间无支出：使用对应期间加 `还没有支出记录～`。
- 信息不足：自然追问唯一缺失信息，不再统一回复“记账失败，请重新发送一条新消息”。

## 交接文件

| 文件 | 用途 |
| --- | --- |
| `README.md` | 发布架构、行为与快速验证 |
| `WINDOWS-HANDOFF.md` | 本文件；部署、运行、恢复与微信验收 |
| `docs/mac-before-windows-checklist.md` | 当前 Mac 版本、运行状态与验收边界 |
| `docs/handoffs/2026-09-16-weixin-rebind-recovery.md` | 微信换绑恢复、数据保留与手机查询确认 |
| `docs/handoffs/2026-09-07-bookkeeping-system-audit.md` | 历史 Windows 发布、跨实例修复与真实微信交叉验收 |
| `docs/handoffs/2026-09-05-secure-ledger-tunnel-gpt6-handoff.md` | 早期 Tunnel 部署检查与历史暂停点 |
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
| `scripts/install-ledger-tunnel-task.ps1` | fail-closed Tunnel supervisor task 安装与复核后首次启动 |
| `scripts/test-ledger-local.ps1` | 本机隔离与安全检查 |
| `scripts/test-ledger-public.ps1` | 公网、token 边界与作品集检查 |
| `scripts/test-ledger-restart.ps1` | 精确任务重启和 fail-closed 检查 |
| `scripts/configure-ezbookkeeping-mcp.ps1` | MCP 配置、token 生成和回滚 |
| `docs/ledger-cloudflare-runbook.md` | Ledger 上线、Cloudflare、验收与恢复主手册 |
| `openclaw-plugins/clawbot-bookkeeping/` | 写入、汇总、MCP resolver 与测试 |
| `openclaw-plugins/openclaw-weixin-stable-id/` | 稳定消息 ID 和发送者元数据 |

本仓库不是完整运行状态备份。恢复另一台主机时，程序、账本数据库、微信登录和所有秘密必须通过单独的安全流程恢复。

## 网页与后续边界

家庭网页固定复用 ezBookkeeping UI，通过专用 Cloudflare Tunnel 发布 `ledger.66ccff-labs.com`。Cloudflare 只承担 TLS、流量规则和传输；SQLite、API/MCP token 与 OpenClaw 留在选定的本地主机；本次参考部署已迁至 Mac。不得增加 Vercel/云数据库同步、Cloudflare Access 双重登录、共享账户或开放 origin 端口，除非获得新的明确设计批准。

## Mac 接续与 Windows 恢复边界

2026-09-16：本机 Docker 虚拟机内存从 4096 调至 2048 MiB，CPU 仍为 2；按维护流程停止业务、重启 Docker 后恢复，原生产版本与数据卷保留。三服务健康、微信轮询、HTTP/MCP 只读检查及公网账本 HTTP 200 通过；采样容器合计约 670 MiB，未出现 OOM kill。此前 OpenClaw cgroup 峰值约 1.45 GiB，因此只确认本次启动与当前负载，未验证持续高负载或真实消息的模型调用/写账。该限制不包含 Mac 上 Docker 界面等进程；若内存不足，按同一维护流程恢复 4096 MiB。

Mac 迁移和 P1–P6 验收已完成，版本及证据见 [当前清单](docs/mac-before-windows-checklist.md)。[远程接入](docs/windows-mac-remote-access.md) 已用于 Windows 侧测试、快照和备份副本传输；Git 同步不会切换不可变服务。

Windows 原生 MCP、安装与恢复接口继续维护。若将来要恢复为生产主机，必须先停止 Mac 写入并备份最新九卷，核对新增交易、确认、去重、游标和授权，再制定经过验证的反向迁移；不能直接启动保留的旧 Windows 数据库。真实反向切换尚未执行。

[维护与备份](docs/mac-maintenance-backup.md)、[授权恢复](docs/mac-authorization-recovery.md) 和 [生产看板](docs/mac-production-dashboard.md) 给出当前入口。维护不清除存储故障，对账不授权自动恢复；双机副本和第二处密钥已验证，实际地址、凭据与回执保存在 Git 外。

## 多币种与每日中行取价

2026-09-13 已部署至 Mac，账户创建、原数据保留及首次取价通过，见 [生产发布记录](docs/handoffs/2026-09-13-production-release.md)；Windows 原生运行仍未完成验收。下方说明通用行为与后续部署边界，不表示参考 Mac 实例尚待创建账户。

新增行为、账户准备及验收入口见 [多币种与汇率](docs/multicurrency-and-rates.md)。OpenClaw 插件后台服务每天 00:00 Asia/Singapore 取一次官网当时最新现汇卖出价；SQLite 日领取记录防止不同实例重复取价，缓存放在回执持久化目录的独立文件，不改变原有确认、去重和可信消息表。当天查询复用，失败保留上次成功值并注明；重启错过当天更新则补取一次。服务不调用模型或发送微信通知。Windows 保留同一插件后台服务和既有安装、恢复入口，本次未完成 Windows 原生验收。

微信默认使用中行适配，ezBookkeeping 网页来源仍由原有配置管理。生产切换须按维护流程备份九卷、准备新一代卷并审核账户创建回执，不能直接修改活动容器或移动旧交易。
