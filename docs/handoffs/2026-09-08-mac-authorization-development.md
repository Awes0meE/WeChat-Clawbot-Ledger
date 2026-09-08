# Mac 授权恢复开发记录（历史）

以下保留 2026-09-08 的各开发检查点，文中“当前”“尚未”只指对应检查点。操作请使用[授权恢复手册](../mac-authorization-recovery.md)，实际部署状态见[正式切换记录](2026-09-09-production-cutover.md)。

# Mac 授权诊断与恢复进度

当前部署补充：完成状态看板 `6ab7c37` 已上线，隔离模型、HTTP/MCP 和微信运行状态卡片已实际发布；下方较早的“候选尚未安装”只指当时检查点。生产看板、真实微信和生产授权导入仍未启用。见 [看板发布记录](2026-09-08-mac-dashboard-completion.md)。

2026-09-08。当前已完成固定官方 Codex 状态检查与独立登录、同账户导入、账本双令牌更新与临时副本验收、微信暂存导入及同一 Tunnel 的维护凭据替换。真实模型调用和各项合成演练已通过，代码已固化为未启用候选 `897f2ab`。完整状态汇总、候选整体运行及真实生产恢复尚未验收，P4 不整体勾选。以下各检查点保留当时结果，最新镜像范围见 [候选记录](2026-09-08-mac-auth-candidate.md)。

## 已有入口

仓库根目录执行：

```sh
node scripts/mac/inspect-model-authorization.mjs --test
node scripts/mac/inspect-model-authorization.mjs '<仓库外已启用生产宿主目录>'
```

第二项仅为未来生产入口；现在没有运行中的 Mac 生产宿主，未正向实测。它核验不可变宿主和容器边界后才检查，不创建容器或启用门禁。两项都在前后复核同一个 Gateway 容器及启动时间，不执行停止、重启、登录、logout、业务工具或模型请求。

脚本只调用固定版本 `models status --agent bookkeeper --json`，捕获原始输出在本机内存中，最终仅输出白名单状态、运行镜像、宿主源码身份和检查时间。不会输出配置路径、profile ID、账户邮箱、凭据、原始错误或 recoveryHint。`hostSourceCommit` 是宿主身份，不是诊断脚本自身的 Git HEAD。

| 输出 | 含义与处理 |
| --- | --- |
| `credentials-present` | 本地固定 Codex 授权路线报告凭据可用；不证明云端接受或仍有额度 |
| `login-required` | 固定 Codex 路线缺少凭据，需本机交互登录；不能靠重启或删除卷恢复 |
| `runtime-unavailable` | 官方运行时不可用；先核验运行时，不据此要求重新登录 |
| `unknown` / `inspection-unavailable` | 未取得可解释、与固定配置一致的状态；保留现场，不能当健康或登录失效 |
| warning `reauthorization-required` | 上游记录了尚在有效期内的 `auth` / `auth_permanent` / `session_expired` profile 故障；没有输出 profile 身份，也不声称全部配置都失效 |
| warning `temporarily-unavailable` / `rate-limited` / `billing-unavailable` | 上游明确的临时失败、限流或账单类别；不自动 logout 或重启 |
| warning `expiry-metadata-needs-verification` | 到期元数据需检查；支持原生刷新时，access token 到期不等于 OAuth 已撤销 |

每份报告明确 `remoteVerified=false`、`restartRecommended=false`。退出码 0 仅表示取得凭据存在且无已记录告警的元数据；2 表示状态需关注；1 表示检查本身不可用。原始输出不落盘。

## 固定上游的限制

从在线镜像读取的 `/app/dist/list.status-command-BciSAaZC.js` 表明 OpenAI 状态检查采用 `readOnly:true`、`allowKeychainPrompt:false` 读取授权。脚本要求该文件 SHA-256 为 `5a37cd8f591c608e1e352b32dfb9e3ffc84aefbb0829f811adcc7dee4e20bbec`；上游改变后必须重新审核。

**不要在此入口追加 `--probe`，也不使用 `models.probe` 代替官方 harness 验收。** 当前固定版本的 `/app/dist/list.probe-DMrs94BX.js` 在探测调用中显式设置 `agentHarnessRuntimeOverride: "openclaw"`。该文件 SHA-256 为 `9086e6a3ac24366561c70553674facce24fb61a28eed94a308c760e0ab240ef3`。本次只读源码核验，没有执行这条替代路线。

实时模型验收须继续走已有 `verify-owner-model.mjs` / `verify-channel-model.mjs` 所用的官方 Codex harness，并保持隔离、串行、无真实微信发送的边界。生产登录与验证不能直接复用带测试身份和测试路径的 P1 探针。

## 本次证据及剩余工作

- 2026-09-08 08:10:47 UTC，在在线隔离 Gateway 上运行检查成功，结果为 `credentials-present`、无 warnings、`remoteVerified=false`。没有新增模型调用。
- 四项定向测试通过：到期元数据、明确故障分类、缺少登录与缺少运行时的区别、未知结构与脱敏边界。
- 下一步需完成受控重新登录入口：验证运行身份、维护停接收、保存授权前状态、本机可见交互、前后配置和持久业务状态核对，再单独恢复；不能清理去重记录和同步游标。
- 模型授权已纳入看板独立卡片（见下节），仍需补齐 HTTP/MCP、微信、Tunnel 的明确失效及恢复路径。`/readyz` 和状态页容器 healthy 仍只证明本地服务，不是这些授权的实时证明。

## 独立交互登录暂存

`3691277` 新增 `model-authorization-stage.mjs`，把会写配置的官方登录命令放进独立的随机新卷。该卷只有 `authorization-stage` 标签，没有生产标签；登录容器只挂这一卷，既不读取旧凭据，也不挂账本、回执、微信、正式配置或 Docker socket。网络仅使用独立 bridge，不共享 origin 的命名空间、不发布端口。专属配置只加载 `openai` 与 `codex`，无消息通道，工具全部拒绝。

```sh
# 只准备独立空间，不发起 OAuth；正式目标改传其不可变宿主目录
node scripts/mac/model-authorization-stage.mjs prepare --test

# 使用上一步在仓库外生成的回执路径
node scripts/mac/model-authorization-stage.mjs inspect '<回执路径>'

# 仅在用户可见的本机交互终端中运行；授权信息不可发到聊天
node scripts/mac/model-authorization-stage.mjs login '<回执路径>'
```

login 强制使用官方 `models auth login --provider openai --agent bookkeeper --device-code`，不带 `--force`、`--set-default` 或替代 provider。没有 TTY 时在调用 OAuth 前拒绝。交互输出直接交给用户终端，Docker 日志驱动设为 none；脚本不捕获或保存验证码与登录链接。同一暂存回执的操作互斥，已有卷消费者时拒绝并发登录。

成功仅输出 `CLAWBOT_LOGIN_STAGED_NOT_IMPORTED`，失败或取消也不导入、不恢复服务。**暂存成功不等于正式授权已更新。** 后续仍需核对所选账户、通过官方持久化接口更新目标授权，以及前后业务状态和配置核对。不要手工复制整个暂存 OpenClaw 目录覆盖生产：该目录内的配置和状态是登录专用的。

本次使用真实固定 ARM64 镜像完成新卷准备及无凭据检查，得到 `login-required`；实际捕获命令被入口拒绝。三个定向测试覆盖卷/网络隔离、禁用通道和工具、拒绝假卷与浮动镜像。初始化中发现并修复了切换目录所有者过早导致的权限错误；失败卷和成功演练卷均按确切标签核验后清理，没有未知资源删除。本次没有执行 OAuth、产生验证码、导入授权或停止任何现有服务；真实交互登录及导入正向验收仍未完成。

## 单条授权更新的保存与保留验证

`05a56d9` 增加 `deploy/docker/model-authorization-renewal.mjs`，使用固定上游 `upsertAuthProfileAfterLoginWithLockOrThrow` 保存一条已有 OpenAI OAuth profile。它要求新旧 `accountId` 元数据相同、新 access/refresh 完整且未过期；这只是离线元数据检查，不是签名校验或云端接受证明。缺少既有 profile、首次授权或换账户不在本入口范围内。

写前对比上游规范化后的 store/state 与原内容。若规范化会丢弃未知字段，拒绝写入；不以删除字段的方式“兼容”。写后完整比较授权 store/state，只允许替换选中 credential 和清除该 profile 的明确失败窗口；其他 profile、选择顺序、lastGood 和使用记录必须相同。异常不打印凭据或自动恢复数据库。

固定 ARM64 镜像中的真实官方保存接口已通过合成演练：另一条授权、未知业务表及 64 位整数/BLOB、授权表内其他行和新增未知列、共享数据库全表、原配置均不变。未知授权元数据的用例在写前拒绝，原数据保留。演练全过程 network=none、仅 tmpfs 写入，源码只读挂载，不挂任何运行卷；容器退出即删除，无凭据、数据库或临时实例残留。

复现入口（仓库根目录，固定本机已验证镜像）：

```sh
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --env OPENCLAW_STATE_DIR=/tmp/clawbot-auth-renewal-check/openclaw \
  --env OPENCLAW_CONFIG_PATH=/tmp/clawbot-auth-renewal-check/openclaw/openclaw.json \
  --env HOME=/tmp/clawbot-auth-renewal-check/openclaw \
  --env CODEX_HOME=/tmp/clawbot-auth-renewal-check/codex \
  --mount "type=bind,src=$PWD/deploy/docker,dst=/checks,readonly" \
  --entrypoint node \
  sha256:1d3fa022e1259ecee4a5bde1a5763ac5b7b32b7dc85373154b704ea0d10beebd \
  /checks/verify-model-authorization-renewal.mjs
```

结果为 `CLAWBOT_OFFICIAL_AUTH_RENEWAL_SINGLE_PROFILE_AND_UNKNOWN_ROWS_PRESERVED`。这是内部保存 helper 的验证；下节记录后续宿主入口。不能直接对运行卷调用这个内部函数。正式导入、首次登录迁移和当前测试登录替换都未执行。


## 维护期间导入已有账户的授权

新增 `scripts/mac/import-model-authorization.mjs`：绑定不可变生产宿主、同镜像的登录暂存回执、当前已验证九卷加密备份、维护标记和启用门禁，核验所有服务已停止、卷身份及输入内容未变化。备份先完整认证，再与当前九卷状态比较。`prepare` 只生成默认未确认的私有核对文件；`apply` 要求该文件明确确认、时间在 30 分钟内，并再次核验全部绑定。

```sh
node scripts/mac/import-model-authorization.mjs prepare '<不可变生产宿主>' '<登录暂存回执>' '<已验证九卷备份目录>'
# 核对输出文件中的绑定；确认时填写 approved=true 及 reviewedAt 的当前 ISO 时间。
node scripts/mac/import-model-authorization.mjs apply '<不可变生产宿主>' '<登录暂存回执>' '<已验证九卷备份目录>' '<已确认核对文件>'
```

这些是未来维护入口，当前未执行生产正向操作。运行镜像必须包含本次新 helper；当前未启用的 `c04e79c` 候选不含该代码，需要后续重新固化镜像。此入口不支持首次创建 profile、换账户或隔离测试目标。

内部容器断网，来源卷与配置只读，只允许目标 OpenClaw 状态卷写入，不挂账本、回执、Codex 状态或 secrets 卷。来源必须恰有一条授权，且账户元数据只匹配一个既有目标。核对绑定涵盖来源数据库文件、目标授权及其运行状态，以及其他完整文件与数据库表/结构；SQLite 的整数、文本和 BLOB 不混淆。非空 rollback journal 会被拒绝，不丢弃恢复数据后强行读取。

通过官方保存接口写入单条授权时，其额外进程登记和数据库租约存放在临时内存空间。演练发现直接使用目标全局状态会更新共享数据库的登记表，因此改为独立子进程临时状态，并保持目标 agent 数据库路径明确不变；凭据仅经过子进程标准输入，不放进命令参数或日志。写后核对共享数据库全表、未知表/列及其他文件，账本和回执再次比对。成功和失败均保留维护，不自动启服务、恢复旧库或宣称云端授权有效；回执始终 `remoteVerified=false`。

验证入口：`node scripts/mac/verify-model-authorization-import.mjs`。本次真实 ARM64 Docker 合成演练通过只读核对、错误绑定拒绝、单条保存、重复旧绑定拒绝、核对后新增文件拒绝、整数改文本后旧绑定拒绝、未处理恢复日志拒绝。拒绝前后的核对绑定保持一致（主动更改的合成输入除外）。无网络、无在线数据挂载；各轮容器自动删除，三个新建卷按精确标签和无消费者检查后删除。当前仅剩原有两台健康测试服务及七个持久卷。

四个新增脚本语法检查通过；宿主入口对不受管理的路径拒绝，未创建资源。**完整生产宿主正向导入和后续官方实时模型调用尚未验收**；内部合成成功不代替真实交互登录或端到端恢复。


## 看板中的授权状态

`0d07f3b` 已发布为新的在线测试宿主，替换原 `9478540`。宿主文件包含新诊断模块并按哈希验证；业务镜像、两台容器身份、启动时间及重启次数均保持不变。已有恢复/回滚入口负责此次切换，保留旧宿主和恢复记录。

看板每五分钟独立调用一次固定官方只读状态检查，不阻塞五秒页面刷新，不申请模型推理。只有运行边界健康时启动检查，同一时刻至多一次。检查前后核验精确容器及启动时间；页面缓存还绑定宿主源码、镜像、容器和启动时间，超过六分钟即显示过期。未知结构、异常检查、不同运行身份或未来时间不显示凭据有效。公开页面只输出固定状态、告警和检查时间，不输出账户、profile、容器 ID 或原始错误。页面失联时授权卡片明确无法确认。

2026-09-08 09:00:45.933 UTC，新宿主的定时检查返回 `credentials-present`、空 warnings、`remoteVerified=false`。真实浏览器已核验页面出现“本地模型凭据存在，云端调用未验证”及对应检查时间，接口返回与页面一致。新旧宿主切换没有重启两台业务容器。八项定向测试全部通过，覆盖精确命令、上游文件变更拒绝、容器重启/替换、缓存时效、故障分类和脱敏；不是实际撤销 OAuth 的演练。

本次只完善隔离测试看板，生产宿主授权状态聚合和其他凭据恢复仍待完成。授权检查不会自动登录、logout、重启或影响连续运行健康计数的既有口径；连续观察仍明确是本地隔离服务的健康证据，新宿主按自身版本重新累计，不继承旧版本时间。临时浏览器会话已关闭，截图核验后清理。


## 账本 HTTP / MCP 授权诊断

`71a7b91` 新增入口，使用宿主已核验的容器身份和共享 loopback；前后比较两台容器、镜像及启动时间。凭据在容器内从已核验的只读 secrets 文件读取，不经过宿主输出或命令参数。它只请求 `GET /api/v1/accounts/list.json` 和官方 MCP SDK 的连接、初始化与 `tools/list`，结束时关闭会话；不调用业务工具、生成令牌或替换文件。

```sh
node scripts/mac/inspect-ledger-authorization.mjs --test
# 正式入口目前只有拒绝/前提核验，未执行生产正向检查
node scripts/mac/inspect-ledger-authorization.mjs '<不可变生产宿主目录>'
```

| 状态 | 含义与后续处理 |
| --- | --- |
| `accepted-read-only` | 当前凭据被只读入口接受；不证明所属账户相同、完整业务功能或公网边界 |
| `credential-unavailable` / `credential-missing` | 文件不可用、格式不合要求或上游明确缺少令牌；检查私有文件及挂载，不生成替代账户 |
| `credential-rejected` / `credential-expired` | 上游明确拒绝或到期；后续通过维护和同账户核验更新正确令牌 |
| `credential-type-mismatch` / `credential-configuration-mismatch` | 上游令牌类型不符，或 HTTP/MCP 配置重复；不能互相复用两种令牌 |
| `interactive-auth-required` | 上游要求交互认证；继续本机可见登录，不在聊天传凭据 |
| `source-denied` / `api-token-disabled` | 来源或功能配置拒绝；检查既有精确 loopback 策略，不扩大 IP 允许范围 |
| `rate-limited` | 认证失败次数或请求限流；等待后再检查，不能立即循环重试 |
| `transport-unavailable` / `request-timeout` / `service-unavailable` | 连接、响应期限或服务故障；不据此判断令牌撤销 |
| `unrecognized-response` / `required-tool-unavailable` | 未识别协议或缺少查询工具；核对固定版本与服务配置 |

分类依据固定账本镜像的 ezBookkeeping 1.6.1、源码 `6ccd0c462100828c78e203792a5b2feb8d569039`，匹配 HTTP 状态与明确错误码组合，不解析错误文字。依据为上游 [错误码定义](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/errs/error.go)、[令牌错误](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/errs/token.go)、[来源限制及失败限额](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/errs/global.go) 和 [认证中间件](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/middlewares/authorization.go)。未知组合保留未知，不能推断为过期。

2026-09-08 09:08:33.491 UTC，在线隔离环境两种授权均返回 `accepted-read-only`，未写交易、未更换凭据、未重启服务。五项定向测试通过；另在 network=none、根文件系统只读、无业务卷的临时 ARM64 容器中，使用真实官方 MCP SDK 和合成 HTTP 服务实测过期、错类型、来源拒绝、限流、503、实际超时、连接拒绝和恢复。后者验证协议与分类行为，不是撤销在线账本真实令牌的演练。成功会话清理均确认，失败输出不含原错误或凭据。容器 `--rm` 自动清理，没有创建临时卷或凭据文件。

HTTP/MCP 诊断目前是手动只读入口，尚未纳入常驻看板。下文记录已有同账户验签、离线保存、维护/备份绑定和保存后的临时账本副本验收；生产正向恢复、微信和 Tunnel 的完整恢复仍需完成；此分项不把 P4 整体标记为通过。


## 已有账本用户与新令牌的签名核验

`76f9045` 增加内部验证器 `ledger-token-validation.mjs`。调用方必须从已单独确认的账本身份传入 `expectedUid`，不能从候选 JWT 自己声明的账户取得它。验证器读取当前数据库的精确令牌记录，用该记录的密钥核验 HS256 签名，检查账户启用状态、API 类型 8 / MCP 类型 5、签发时间、令牌和记录的有效期、唯一匹配记录。UID 和令牌 ID 全程使用十进制字符串/BigInt，保留超过 JavaScript 安全整数范围的身份。错误只返回固定拒绝标识。

固定版本依据为上游 [TokenService 的签名与解析](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/services/tokens.go)、[claims 格式](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/core/token_claims.go) 和 [数据库记录](https://github.com/mayswind/ezbookkeeping/blob/6ccd0c462100828c78e203792a5b2feb8d569039/pkg/models/token_record.go)。这是写入前的独立验证，不取代账本服务，也不生成、撤销或替换令牌。

五项定向测试通过，覆盖错误签名、不同账户、类型互换、到期、未来签发、撤销、禁用/删除用户、重复记录、异常算法及大整数。真实 SQLite 用例在每次只读核验前后比较整个数据库文件哈希，未知 BLOB 表保持不变，临时数据库目录在 finally 清理。

另以无网络临时 ARM64 容器、只读账本和 secrets 挂载，对现有隔离令牌做了真实验签。预期账户来自独立已知的 `clawbot-test` 用户名，未从 JWT 推导。结果为 `CLAWBOT_LEDGER_TOKEN_PAIR_VERIFIED_OFFLINE`，同账户、类型及两条签名均通过；未输出 UID、令牌或记录密钥。没有访问 8888，没有请求网络或修改账本。更新入口仍需连接维护、已验证备份、可信身份确认和持久化替换，不能把此 helper 当成完整令牌轮换。

## 本机重新登录与实际模型返回已通过

用户本次在可见终端完成独立 OAuth 登录后，暂存状态检查返回 `credentials-present`、无 warnings。随后用新增 `verify-model` 入口实测固定官方 Codex harness：

```sh
node scripts/mac/model-authorization-stage.mjs verify-model '<已有登录暂存回执>'
```

入口仍核验暂存卷标签、固定镜像和独占状态，不挂在线业务卷。执行前验证无通道、全部工具拒绝、固定模型与 harness；用随机新会话请求一个固定测试短句。2026-09-08 09:23:24.639 UTC 实际返回通过：`gpt-5.6-sol`、`codex`、准确合成回复、动态工具列表为空，`remoteVerified=true`。没有发送微信或调用记账工具。成功回执在仓库外 `operations/authorization-stages/` 保留，旧版首次回执没有额外 model/harness 字段，但生成前已经断言两者；后续新回执也显式保存这两个固定值。

这是新登录在独立暂存环境的实际云端验证。**尚未把新授权导入在线测试或生产宿主**，也没有切换 Windows。登录和模型检查容器均已退出自动删除；暂存授权卷及回执仍需用于后续导入验收，予以保留，不按无用临时卷删除。现有看板只反映在线隔离服务的只读凭据检查，不借用本次暂存结果宣称在线云端调用已验证。

## 账本令牌离线保存与中断续写

`51fea8f` 增加内部 `ledger-token-rotation.mjs`，`e3dd5be` 补充真实 crash-left WAL 用例。该组件**不能直接对在线卷调用**。`285b543` 已补充下节的宿主维护/备份绑定入口；`891d0c8` 已补充保存后的临时账本副本验收。真实在线测试和生产令牌未更换；后续真实服务演练仅在新建的合成账户中生成、撤销和更新令牌。

组件提供 `inspect`、`apply` 和显式 `resume`。预期用户名来自单独核对的账本身份，数据库必须恰好匹配一个启用用户；不从候选 JWT 取得预期用户。来源两文件分别验签、验类型及数据库撤销记录，读取 SQLite 时复制数据库和现有 WAL/SHM 到临时空间，不改原库；非空 rollback journal 拒绝。复制预算为 512 MiB，超过预算时停止，不截断数据。

核对绑定包含来源全文件、原账本目录全文件、其他 secrets 文件、原两条令牌及已核对身份。保存前重新比较；每个输入令牌文件要求当前进程所有者/组、0600、单链接普通文件，拒绝符号链接。两令牌内容不会进入回执或输出。

两份固定文件不能一起原子替换，因此在第一份文件更改前持久保存 `.ledger-token-rotation.json`，每个临时文件写入和替换后均同步到磁盘。启动前检查及生产宿主 preflight 拒绝未完成标记或残留临时文件；生产 Gateway 的已有定时门禁也检查该标记。失败保留维护及更新记录，不能删标记后启动。`resume` 只接受原核对绑定、相同来源/账本/其他状态，且现存两令牌各自必须仍等于原值或候选值；过期、撤销或内容改变继续拒绝。它可在此条件下替换该操作留下的私有不完整临时文件，完成后再次核对再清除标记。若标记本身不完整或损坏，应保留现场重新审核，不能自动猜测或恢复旧数据库。

验收范围：

- Mac Node 测试最初 8 项通过；固定 ARM64 镜像同样 8 项通过。随后新增的 WAL 用例与 3 项保存用例在该 ARM64 镜像全部通过。另有 3 项运行策略/生产策略回归通过。
- 真实子进程在第一份令牌 rename 后收到 SIGKILL，确实留下新 HTTP / 旧 MCP 混合状态；启动检查拒绝，错误绑定不能续写，原绑定续写后两份均匹配候选。
- WAL 用例先写入未知 BLOB/大整数记录并强制终止写进程，检查后 WAL 字节不变；再将 MCP 撤销写入已提交 WAL 并强制终止，验签入口拒绝，未遗漏 WAL 中的新状态。
- 以独立 tmpfs 和只读源码挂载执行真实 `entrypoint.mjs` 与 `production-preflight.mjs`，二者都在更新标记存在时拒绝。无网络、无在线业务卷、无启动接收器。
- 所有演练容器自动删除，合成数据库及中断进程临时目录随测试清理。已登录的授权暂存卷及其验收回执继续保留。

这些启动改动尚未发布到在线测试镜像或 `c04e79c` 候选。后续必须固化包含全部授权恢复代码的新镜像，再验收宿主完整入口；不能把内部保存和故障演练记成 P4 整体完成。

## 宿主令牌更新入口

`285b543` 新增 `scripts/mac/rotate-ledger-tokens.mjs`，仅供未来已启用且进入维护的不可变 Mac 生产宿主使用；当前没有该生产环境，未执行真实生产 CLI 正向操作。它核验宿主文件、镜像/卷身份、已安装与加载的任务、启用门禁、维护批次、无存储故障锁和九卷无任何运行消费者。更新期间不会停止未知容器，也不会清除维护或启动接收器。

新 HTTP/API 与 MCP 令牌须先通过原账本授权流程取得，并已存在于同一账本数据库；此入口不生成令牌。新记录生成后再进入维护并制作已验证九卷备份，否则旧备份与当前数据库不匹配，入口会拒绝。身份依据是操作人员单独核对的账本用户名，不能用 JWT 自述填入。

输入放在仓库外 `operations/` 的私有目录中：

- 新建仅包含 `http-token` 与 `mcp-token` 的目录，目录 0700、文件 0600，均属于当前 Mac 用户。通过本机可见流程保存，不能把令牌放进命令参数、聊天或 Git。
- 另存一份私有身份文件，内容为 `{"version":1,"expectedUsername":"已核对的账本用户名","reviewed":true}`。这是输入格式示例，不是真实账户；必须替换为实际核对结果。身份与两个候选文件分别哈希绑定。

依次执行已有维护/备份入口，再使用新的核对与保存入口：

```sh
node scripts/mac/production-maintenance.mjs enter '<不可变生产宿主>'
node scripts/mac/backup-production-state.mjs '<不可变生产宿主>'
node scripts/mac/rotate-ledger-tokens.mjs prepare '<不可变生产宿主>' '<候选令牌目录>' '<私有身份文件>' '<已验证备份目录>'
# 核对生成的私有 review 文件，确认后填写 approved=true 与当前 ISO reviewedAt。
node scripts/mac/rotate-ledger-tokens.mjs apply '<不可变生产宿主>' '<候选令牌目录>' '<私有身份文件>' '<同一备份目录>' '<已确认 review 文件>'
```

核对文件在 `operations/ledger-token-updates/`，30 分钟有效。每次操作完整认证加密备份；首次保存还要求当前九卷的完整审核与备份完全一致。更新前先持久保存 started 记录，写后保留 saved 回执、到期时间及九卷审核。所有输出均为状态和私有回执路径，不输出身份或令牌。

只有临时离线容器的标准输入携带候选令牌和核对身份；不放进参数、环境变量或 Docker 日志。容器仅挂账本只读卷及 secrets 卷，前者不允许写，后者仅在保存/续写时可写。临时输入和 SQLite 副本在 tmpfs，容器自动删除。若 Docker 客户端超时，宿主仅检查并停止该操作的精确标签与镜像匹配的 helper，避免留下后台写入进程。

更新被中断时，保留原输入、备份和核对文件；确认仍匹配后使用：

```sh
node scripts/mac/rotate-ledger-tokens.mjs resume '<同一不可变宿主>' '<同一候选目录>' '<同一身份文件>' '<同一备份目录>' '<同一核对文件>'
```

续写要求原 started 记录匹配。它用限定范围的九卷审核允许两令牌及更新标记变化，其他全部文件和两库仍须相同；内部保存器另验证原/新令牌及标记。started 已落盘但尚未开始写入时，只能按原绑定开始；两份已保存但宿主回执未落盘时，执行无写入的同账户验签与候选精确匹配，再补回执。标记损坏、来源变化或新令牌已撤销/过期仍拒绝，不能通过删除标记强行恢复。

**保存成功仍保持维护，`remoteVerified=false`。** 下一节给出不启用接收器的 HTTP/MCP 副本验收入口；之后仍需单独恢复和检查实际服务，不应把保存成功直接当成恢复收发的依据。

本次验证：13 项令牌/保存/宿主流程定向测试通过；流程用例覆盖未确认/超时 review、身份/输入/备份变化、备份与当前数据不符、运行消费者拒绝、写入及写后审核失败、缺少原 started 记录。实际固定 ARM64 Docker 的 `node scripts/mac/verify-ledger-token-import.mjs` 通过中文身份、错误绑定拒绝、两处回执间隙恢复、第一份文件写后实际 SIGKILL 和续写。九卷审核另在无业务卷的 tmpfs 容器实测：只排除固定的两个令牌和三个操作文件，未知 secret 与回执表变化均被检出，任意扩大排除参数被拒绝。生产 CLI 对不受管理路径拒绝。完整生产宿主正向验收仍属于后续发布/交接窗口。

演练期间曾发现容器 PID 1 的信号行为使自发 SIGKILL 没有终止测试进程；演练改用 Docker init，使被终止者为真实子进程，再次运行通过。没有据第一次未终止的运行宣称故障演练通过。两个随机合成卷及全部临时容器已按标签和无消费者检查后删除；已有真实登录暂存继续保留。

## 保存后的真实 HTTP / MCP 副本验收

`891d0c8` 增加入口：

```sh
node scripts/mac/check-saved-ledger-tokens.mjs '<不可变生产宿主>' '<本次 saved 回执>'
```

这是未来已启用生产宿主的维护入口，当前没有执行生产 CLI 正向操作。它核验 saved 与 started 回执、同一宿主/镜像/维护批次、任务和门禁、无存储故障，以及当前完整九卷与 saved.afterAudit 一致。保留至少 10 GiB 主机/Docker 空间并检查副本预算，才创建临时副本。

临时卷仅复制账本数据和配置；源卷只读，复制前后检查源数据，WAL/SHM 等文件一起保留。副本配置保留原 API/MCP 启用与精确 loopback 来源限制；只将端口设为 18888、路径改为临时卷内路径、日志指向临时副本并关闭请求/查询日志。它运行固定的真实 ezBookkeeping 镜像，network=none，不发布宿主端口。独立 Node 容器共享该副本的 loopback，只读挂载保存后的 secrets，执行现有 HTTP accounts/list 与官方 MCP SDK 初始化/tools/list，然后关闭会话；没有微信、模型或业务写入工具。

结果分别报告 HTTP/MCP 分类。两项均接受且会话清理确认时，`serverAcceptanceVerified=true`；始终 `productionServiceVerified=false`、`maintenanceRequired=true`。这个结果证明相同数据与授权配置的临时服务接受令牌，不证明正式端口、Tunnel、微信或整套生产收发已经恢复。取得授权报告后，无论接受或明确拒绝，都会在仓库外保存检查回执；前提或执行异常仅报告检查中止，不伪造验收结果。两者继续保留维护，实际服务恢复后仍须运行原有运行检查。它不会自动调用 maintenance resume。

检查前、中、后反复核对原九卷；副本服务的启动与认证访问只可能改变临时副本的日志/认证访问记录。临时副本和 helper 按本次随机名称、标签与镜像核验后停止、删除，再核验原卷没有变化。任何失败不会删除源卷或恢复原数据库。

复现真实账本演练：`node scripts/mac/verify-ledger-token-recovery.mjs`。本次使用三个随机新卷、合成账户及固定账本程序的官方 userdata 命令取得新 API/MCP 令牌，执行以下顺序：

1. 离线保存器验签并替换合成旧凭据；副本 HTTP 和 MCP 均被真实服务接受。
2. 仅删除该合成账户的 MCP 令牌记录；副本 HTTP 仍接受，MCP 返回 `credential-rejected`。
3. 用官方命令签发新的合成 MCP 令牌，经同一保存器更新；两项恢复接受。
4. 在副本已启动时注入源核对失败；检查拒绝，副本被清理，源数据仍等于原基线。

各轮核对合成源全文件内容与权限，未挂载任何在线业务卷。演练为对接内部生产保存器，在合成卷中保留内容匹配的生产/测试数据库文件名；没有把这项路径适配当成 Windows 真实布局验证。13 项已有定向测试再次通过，新宿主入口对不受管理路径拒绝。初始化演练中修正了目录所有权切换顺序及缺少数据库子目录的问题，失败资源和最后通过的资源都已清理。

本次新增三个源卷、每轮账本副本和全部临时容器均已删除；在线两台测试服务未重启，新登录授权暂存卷继续保留。新入口尚未包含在在线测试镜像或 `c04e79c` 待用镜像中，需后续重新固化候选。P4 尚有其他授权恢复和长期观察要求，不能整体标记完成。

## 微信轮询的授权状态

`5893600` 修正固定微信插件的运行状态上报。依据是仓库内固定上游 `src/api/session-guard.ts` 的 `STALE_TOKEN_ERRCODE=-14`，不从错误文字推断过期。原有一小时暂停和正常重试策略保留；新增以下 `lastError` 固定标识，并在通道汇总中暴露 `connected`：

| 状态 | 含义 |
| --- | --- |
| `CLAWBOT_WEIXIN_LOGIN_REQUIRED` | 启动时未配置凭据，接收器没有启动 |
| `CLAWBOT_WEIXIN_AWAITING_POLL` | 正在启动，尚无服务器轮询成功证据 |
| `CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED` | 服务器 `ret` 或 `errcode` 明确返回数字 -14，沿用原有暂停 |
| `CLAWBOT_WEIXIN_POLL_TIMEOUT` | 客户端长轮询超时，没有服务器返回；不能据此宣称授权有效或要求重新登录 |
| `CLAWBOT_WEIXIN_TRANSPORT_UNAVAILABLE` | 轮询请求抛出异常，不自动认定为授权撤销 |
| `CLAWBOT_WEIXIN_API_UNAVAILABLE` / `CLAWBOT_WEIXIN_RESPONSE_UNRECOGNIZED` | 其他非零状态，或缺失/不合法状态结构；保留未知原因 |
| `CLAWBOT_WEIXIN_MESSAGE_PROCESSING_FAILED` | 已收到轮询响应，之后处理消息失败；不混同为连接或授权失败 |
| `connected=true` 且 `lastError=null` | 最近服务器返回明确成功码；不证明其他服务或永久授权有效 |

已观察到 -14 后，同一运行中的超时、网络故障或未知响应不会清除重新授权状态，只有服务器明确成功才清除。这个标记属于运行状态，尚未跨进程持久化；重启首先显示 awaiting-poll，不能当作重新授权成功。新上报不包含原始错误、微信身份、正文或凭据。

固定上游此前把本地 AbortError 包装为 `ret=0` 的空响应。现在该本地结果附带 `localTransportTimeout`，monitor 不将它视为服务器成功，也不重新保存同步游标；外部停止信号直接退出。真实成功响应继续原有游标及消息处理路径。

插件已重新构建，受版本控制的 dist 同步提交；22 项 Node 测试全部通过，包括原有稳定消息 ID、配对授权与媒体边界，以及新增的 -14 → 超时/网络故障 → 明确成功、游标保留、消息处理异常和实际超时适配器测试。运行 monitor 及 API 代码时替换了网络、持久存储与宿主依赖，没有请求真实微信、扫码、发送消息或使用真实身份。没有新增 Docker 实例或临时凭据。

这项修正尚未发布到在线 Mac 镜像或 Windows 生产发布。它补齐微信失效可见性，尚未提供维护期间的同账户扫码、保存、恢复及实际微信验收；也未将状态接到 Mac 常驻看板。Tunnel 目前仍只有连接/未连接与本地边界检查，明确授权分类及恢复仍需继续完成。

## 微信同账户凭据保存组件

`b90c98a` 增加内部 `deploy/docker/weixin-authorization-renewal.mjs`。读取固定上游代码发现，普通扫码成功路径会调用 `clearStaleAccountsForUserId`，删除同一用户的其他账户数据，再触发通道配置重载；`saveWeixinAccount` 也会重新构造已知字段，未保留未知扩展字段。迁移恢复因此需要独立暂存扫码结果，再通过受控保存组件更新原账户，不能直接在运行卷上执行完整扫码保存流程。

组件的 `inspect` / `apply` 由后续宿主入口调用，**当前不可直接对在线卷使用**。调用方必须先证明维护、已验证备份、无卷消费者，并从审核过的运行路由取得原 accountId 与所有者 userId。组件要求该账户在原索引中恰好出现一次、原账户文件所有者一致、新凭据 accountId/userId 与原身份一致，且 API baseUrl 不改变；不自动创建账户、不接受换账户或来源地址调整。

保存只更改该文件的 token 与 savedAt，保留其所有其他字段。未知 JSON 数字若超出可安全保留的整数范围则拒绝，不能在重新序列化时默默舍入。原索引、同一用户的其他账户、同步游标、上下文 token、配对文件、配置和整个 OpenClaw 状态目录均纳入前后文件审核；其他 SQLite 按文件字节核对，不执行数据库更新。Unix socket 不属于持久状态，沿用既有审核范围排除。

核对绑定包含旧凭据文件、新候选、原身份和其他全部状态；核对后游标或其他数据变化会使旧绑定失效。保存先写入本次随机私有文件并同步，再原子替换指定账户文件、同步目录；写后检查字段及其他状态。替换前失败保留原凭据，只清理确认属于本次操作的临时 inode；不会执行上游的旧账户清理或通道重载。成功始终返回 `remoteVerified=false`、需要继续维护。硬中断残留或写后核对失败仍需保留现场处理，不能自动宣称恢复完成。

三项定向测试在本机 Node 与固定 ARM64 Docker 镜像均通过：同账户更新、保留同用户的另一账户/游标/上下文/配对/未知字段及含 64 位整数和 BLOB 的数据库原字节；不同账户/所有者/端点、改变游标及不安全未知数字拒绝；在实际子进程中模拟原子 rename 失败，原凭据和核对绑定不变，临时文件清理。演练无网络、无在线卷，临时数据库和容器均已清理。

该组件尚未连接交互扫码暂存、宿主维护/备份导入入口或真实微信恢复验收，也未包含在运行镜像中。本次没有向腾讯发起扫码、取得二维码或更换真实微信授权，Windows 继续保留生产接收权。

## 微信独立扫码暂存

`ff118f4` 增加 `scripts/mac/weixin-authorization-stage.mjs`，将扫码前提绑定到不可变生产宿主、当前维护标记、已认证并恢复核验的九卷加密备份、启用门禁及停止状态。检查全部运行容器，任何生产卷仍有消费者都会拒绝；当前九卷审核必须与备份一致。当前 Mac 没有真实生产宿主，不能提前使用这一入口扫码。

```sh
node scripts/mac/weixin-authorization-stage.mjs prepare '<生产宿主目录>' '<已验证九卷备份目录>'
node scripts/mac/weixin-authorization-stage.mjs inspect '<同一宿主>' '<同一备份>' '<暂存回执>'
# login 仅在用户可见的交互终端执行
node scripts/mac/weixin-authorization-stage.mjs login '<同一宿主>' '<同一备份>' '<暂存回执>'
```

prepare 创建单独的私有卷，从只读运行配置和账户文件核对原路由与所有者，仅保存身份，不复制旧 token。实际 login 容器只挂这个暂存卷，使用临时 OpenClaw 状态目录，不挂业务卷、不发布端口，Docker 日志关闭；没有交互终端会在请求二维码之前拒绝。官方 `startWeixinLoginWithQr` / `waitForWeixinLogin` 只负责协议，候选凭据另存私有文件，不调用常规登录路径的账户清理或配置重载。

候选必须属于原微信用户。同一用户返回不同机器人账户或 API 地址时只标记 `REQUIRES_IDENTITY_REVIEW` 并保留候选，不能交给同账户保存组件直接更新。错误所有者、不完整结果和无 token 结果均不保存；`alreadyConnected` 只报告没有新凭据。操作前后重新核对维护、回执及完整备份状态，成功也不导入或恢复服务。

六项新增定向测试与三项既有保存测试通过。`node scripts/mac/verify-weixin-authorization-stage.mjs` 在固定 ARM64 镜像中执行真实官方协议和规范化函数，以合成 HTTP 响应完成暂存；另验证初始化、拒绝重复初始化/错误绑定/非交互登录、同用户改身份待核对、错误所有者拒绝以及原配置/账户/游标字节不变。全部断网，三个写入目录均为临时内存盘，无真实二维码、业务卷或新增持久卷，退出后清理。该结果不等于用户实际扫码成功，也不等于宿主 CLI 的生产正向验收。

后续仍须实现暂存到目标账户的宿主导入、保存后回执间隙恢复及实际停服后的微信恢复验收，固化包含这些脚本的新候选镜像。Windows 继续作为生产接收端，运行镜像未更新，P4 保持未完成。

## 微信保存完成但回执未生成时的只读核验

保存组件现增加 `verify-saved`。inspect 生成不含凭据的核对记录，绑定原文件摘要、新文件摘要、其他状态摘要及固定 savedAt；apply 必须使用这份原记录，不在重试时重新生成保存时间。未来宿主必须在写入前持久保存该记录，才能在写后回执缺失时使用它核验。

`verify-saved` 不写文件，完整检查新凭据文件字节、候选/原身份绑定、保存时间与其他 OpenClaw 状态。原凭据仍未替换、候选或核对记录改变、保存后游标变化都会拒绝。成功仅报告 `CLAWBOT_WEIXIN_SAVED_CREDENTIAL_VERIFIED`，不证明腾讯接受、不清除维护、不启动接收。

新增故障测试在真实子进程完成原子 rename 后立即 SIGKILL，确认子进程确实被信号终止，再仅凭写前核对记录完成两次只读验收；文件、未知 SQLite 字节及目录列表保持不变。四项保存测试在本机 Node 和固定 ARM64 镜像全部通过，合成数据与临时容器清理。宿主导入及回执续写尚未接入；rename 前硬中断留下的随机临时文件仍会导致状态核验拒绝，需要保留现场处理，不能据此声称所有中断均可自动恢复。

## 微信暂存导入的宿主维护入口

`28999f3` 接入 `scripts/mac/import-weixin-authorization.mjs`：

```sh
node scripts/mac/import-weixin-authorization.mjs prepare '<生产宿主目录>' '<已验证九卷备份目录>' '<微信暂存回执>'
# 核对生成的私有记录后，将 approved 设为 true，并填写 reviewedAt。
node scripts/mac/import-weixin-authorization.mjs apply '<同一宿主>' '<同一备份>' '<同一暂存回执>' '<已确认核对记录>'
node scripts/mac/import-weixin-authorization.mjs resume '<同一宿主>' '<同一备份>' '<同一暂存回执>' '<原已确认核对记录>'
```

入口复用维护、已认证备份、精确卷/宿主身份、启用门禁、无卷消费者和操作锁。prepare 必须与完整原备份一致，生成默认未确认记录。apply 要求 30 分钟内确认，先持久保存包含核对记录摘要的 started 文件，再执行写入。备份状态、暂存来源、候选、配置、身份或核对记录发生变化都会拒绝。

容器导入组件断网，只读挂载暂存卷与运行配置，仅 apply 允许目标 OpenClaw 状态卷写入；不挂账本、secrets 或回执卷。目标账户的 token/savedAt 是唯一允许改变的字段，其他 OpenClaw 状态由内部组件完整审核；外层使用明确标记 `excluding-openclaw-state` 的审核核对其余八卷，再检查两库原审计及最终完整九卷状态。该局部审核不能单独作为全部状态保留的证据，必须和内部保存组件的结果一起使用。

resume 必须找到与原确认记录完全匹配的 started 文件。若当前完整状态仍等于原备份，可以续接首次写入；若状态已改变，只运行全部卷只读挂载的 verify-saved，不能自动重新写入。确认时限按最初 started 时间检查，因此已开始操作在一天后恢复回执不需要伪造新的确认时间；任何核对记录改动都会拒绝。成功只保存回执、保留维护，不自动重新登录、启动服务或恢复数据库。其他字段/文件改变及 rename 前残留仍会拒绝。

16 项定向测试通过，覆盖暂存与导入挂载隔离、完整保存、前后中断、回执缺失续接、无 started/错误核对/过期首次确认、无关状态改变拒绝。ARM64 断网演练通过真实官方扫码协议的合成响应、实际暂存读取、目标写入及两次只读验收；改变候选、运行配置、游标均拒绝；其他八卷审核能识别未知 Codex 文件和含 64 位整数/BLOB 的账本变更。既有账本令牌更新审核演练仍通过。六个写入根目录均使用临时内存盘，容器已清理，无真实扫码或生产卷写入。

这证明了宿主操作逻辑与实际容器组件，尚未执行完整生产宿主 CLI 的正向操作，也尚未固化新运行镜像。真实微信账户恢复、服务恢复后的轮询和消息验收留待 Windows 停服切换后；Tunnel 授权恢复和长期观察等 P4 任务仍未完成。

## Tunnel 注册与凭据诊断

已核对 [Cloudflare 本地 Tunnel 权限说明](https://developers.cloudflare.com/tunnel/advanced/local-management/tunnel-permissions/)：当前本地管理模式的运行凭据文件不按时间到期，网页登录生成的账户管理证书用于管理 Tunnel，不能把重新登录当成运行凭据的通用修复。

guard 现在让固定 cloudflared 2026.8.3 输出 JSON 到其专属子进程 stderr 管道。仅内存中解析，未设置日志文件、不转发原文，单行超过 16 KiB 字符即丢弃并在下一换行恢复。对外仅保存固定分类与时间，不暴露账户、连接 ID、IP、原始错误或凭据。

分类依据固定版本的 [注册错误分支](https://github.com/cloudflare/cloudflared/blob/2026.8.3/supervisor/tunnel.go)、[注册成功事件](https://github.com/cloudflare/cloudflared/blob/2026.8.3/connection/observer.go) 和 [JSON stderr 配置](https://github.com/cloudflare/cloudflared/blob/2026.8.3/logger/create.go)。仅识别 event=0、合法 connIndex 与固定 message/level。明确 Invalid tunnel secret 的注册拒绝显示 `credential-rejected`；Failed to get tunnel 显示 `tunnel-unavailable`，不推断具体原因；其他注册失败与拨号故障分别显示 `registration-failed`、`transport-unavailable`。前两类服务器错误文本可在官方仓库的 [历史报告 426](https://github.com/cloudflare/cloudflared/issues/426) 和 [报告 1572](https://github.com/cloudflare/cloudflared/issues/1572) 核对，尚未以当前正式 Tunnel 实测撤销响应；其他未知文本不会被泛化成凭据失效。

明确拒绝后，网络异常不会清除该结论；后续明确注册成功才更新为 `last-registration-accepted`。这是最近一次注册的历史证据，另带观察时间，不是一次新公网探针。守护的原端口/程序/配置审核、两次连续本地验证及内核父进程退出约束继续生效；`/ready` 仍独立判断当前连接状态，日志分类不绕过它。

```sh
node scripts/mac/inspect-tunnel-authorization.mjs '<不可变生产宿主目录>'
```

只读入口核验精确 guard 身份及网络命名空间，读取前后对比容器 ID 和 StartedAt；早于本次启动、来自旧容器、未来时间或超过 10 秒的状态均拒绝。结果始终 `remoteVerified=false`。尚未运行的宿主不启动 Tunnel，状态页也尚未接入此卡片。

七项定向测试在 Mac 和固定 ARM64 镜像通过，包括实际子进程 stderr、分片/超长/错误 JSON、错误分类、旧子进程事件、时效及容器重启核对。固定 cloudflared 文件摘要核验和 JSON 参数帮助命令断网通过；内核父进程退出后子发布进程终止的真实容器演练通过。没有连接 Cloudflare、修改 DNS/路由/凭据、停止在线测试服务或改变 Windows。临时容器已清理，代码尚未固化到运行镜像；同一 Tunnel 凭据的维护替换和实际生产恢复仍待完成。

## 同一 Tunnel 的维护凭据替换

`8222a42` 增加 `scripts/mac/import-tunnel-credential.mjs`。此入口只导入已经通过原管理流程取得的同一 Tunnel 新凭据文件；不申请账户管理证书、不调用 Cloudflare API、不创建或删除 Tunnel、不修改 DNS。候选文件须置于仓库外私有 `operations/` 下，普通文件、当前用户所有且无组/其他用户权限，不在聊天中传递内容。

```sh
node scripts/mac/import-tunnel-credential.mjs prepare '<生产宿主目录>' '<已验证九卷备份目录>' '<私有候选凭据 JSON>'
# 核对生成的私有记录后，将 approved 设为 true，并填写 reviewedAt。
node scripts/mac/import-tunnel-credential.mjs apply '<同一宿主>' '<同一备份>' '<同一候选>' '<已确认核对记录>'
node scripts/mac/import-tunnel-credential.mjs resume '<同一宿主>' '<同一备份>' '<同一候选>' '<原已确认核对记录>'
```

入口要求已启用的精确生产宿主处于维护、三项服务已停止、没有卷消费者、当前存储故障门禁未触发，已验证九卷备份通过完整认证。prepare/apply 前当前状态必须等于备份。候选、运行配置、守护策略、Windows 停服回执与原文件摘要共同绑定；TunnelID、AccountTag、sourceCommit、来源快照和切换批次必须保持一致。只更新原凭据文件的 TunnelSecret，保留原文件其他未知字段和 0400 权限。未知不安全 JSON 数字拒绝，换账户/换 Tunnel/改路由不在此入口范围内。

容器全程断网，只挂 Tunnel 配置和只读守护配置；apply 是唯一可写阶段。全九卷审核只排除固定路径 `tunnel-config/credentials.json`，其余文件、临时残留、两库全表均检查；凭据文件内容和权限由内部组件单独检查。保存先写本次随机临时文件、同步后原子替换并同步目录。rename 前失败保留原文件并清理确认属于本次的临时 inode；硬中断残留仍要求保留现场核对，不自动删除或恢复数据库。

微信与 Tunnel 复用同一套写前 started、写后 saved 回执流程，记录中明确区分 operationKind；不同类型不可交叉续接。resume 只从完整原备份状态重试首次写入，已变化状态必须通过全只读 verify-saved 才能补回执。成功仍保留维护，`remoteVerified=false`，不证明 Cloudflare 接受该密钥。缺失/损坏的原凭据、已删除的 Tunnel 或需要改变路由的情况不会被自动当作同身份替换处理。

10 项凭据/回执定向测试在 Mac 和 ARM64 通过，覆盖未知字段保留、身份/批次/编码/核对错误拒绝、rename 失败、实际 SIGKILL 后只读恢复及类型混用拒绝。`node scripts/mac/verify-tunnel-credential-update.mjs` 的真实容器演练通过实际导入、重复只读确认、0400 权限、固定 cloudflared ingress validate，以及排除审核能发现其他未知文件、临时残留和含 64 位整数/BLOB 的回执数据库变化。演练首次碰到只读合成副本覆盖失败，修正复制步骤后重跑通过；没有放宽运行文件权限。全部使用独立临时内存盘，无线上卷、真实凭据或网络连接，退出后清理。微信暂存/导入与账本令牌审核回归也通过。

仍须固化包含新代码的镜像，并在正式维护窗口核验完整宿主入口；之后按原维护恢复流程启动受保护服务，再检查 Tunnel 诊断、当前连接和公网验收。当前 Windows、正式 DNS/Tunnel 和两台隔离服务未改变，P4 仍不能整体完成。

## 账本授权看板候选

`b46868f` 将现有 HTTP/MCP 只读检查提取为共享组件，手动 CLI 和看板复用同一协议。看板后台每五分钟检查，独立于五秒页面刷新；前后均验证账本与代理容器的完整运行身份、镜像、启动时间和共享 namespace。结果绑定两项容器及宿主版本，超过六分钟、时间异常、任一身份变化或运行边界异常均不显示授权通过。页面只投影固定状态和检查时间，不输出账户、凭据、原始错误或容器身份；会话清理未确认单独提示。

16 项定向测试通过，覆盖原协议、双容器重启/替换/停止、未知返回、结果过期、模型检查与三小时观察回归。页面脚本合成渲染验证通过、失效、过期、断连及清理异常。11:39:53 UTC 在线隔离服务实际 HTTP/MCP 检查均通过；11:42:26 UTC 从仓库外只读宿主候选加载组件再次通过，发布文件哈希及只读权限核验完成。检查只读取账户列表、初始化 MCP 和列出工具，不执行历史工具、不写交易、不更换授权。

宿主候选位于 Git 外 `host-releases/b46868f522a39a044ab78955334bad9b8342cbbd/`，已准备但未安装；在线看板保持 `d53b535` 积累三小时观察。当前结果不等于新看板整机发布验收，生产状态聚合与微信状态接入仍待完成。没有新增测试容器、卷或临时文件。

## 微信运行状态检查与看板候选

`f5f7895` 新增 `inspect-weixin-authorization.mjs --test` 及生产宿主目录入口。生产检查先验证精确宿主/容器及 namespace，再由容器内正式启用校验读取选中的私有账户；通过固定官方 `channels status --channel openclaw-weixin --json` 取得 Gateway 快照，不使用 `--probe`、登录或启接收命令。两个上游状态模块以固定 SHA-256 核对。命令退回 config-only 时明确显示 Gateway 不可用，不把配置完整当作在线。

结果只针对配置绑定的唯一账户；未知状态、重复账户、未来/过期快照拒绝。最近成功轮询要求运行、配置、连接状态明确，事件晚于本次渠道启动且在五分钟内；过旧事件显示 poll-stale。明确 -14、网络、本地超时与消息处理错误分别保留固定分类；它们不是立即自动重启的理由。检查前后核对容器身份和启动时间，输出不含账户、token 或原始错误；`remoteVerified=false`、`messageAcceptanceVerified=false`，因为没有新发真实微信或现场授权探测。

隔离模式只检查微信未启用，不调用 Gateway 或腾讯。11:49:21 UTC 实际隔离入口返回 not-enabled；11:53:20 UTC 从仓库外只读宿主候选加载检查再次通过，文件哈希/权限核验完成。候选看板仅显示该隔离配置及检查时效，不会展示被错误注入的真实接收成功。候选 `host-releases/f5f789559b5769426c139868b84241da3499f403/` 已准备但未安装，包含上一版账本卡片。在线宿主继续为 `d53b535`，三小时观察不因本次准备重启。

六项新增测试和十一项模型/账本/观察回归通过。`verify-weixin-authorization-inspection.mjs` 在固定 ARM64 镜像断网运行真实官方命令模块，仅替换 Gateway 传输与显示依赖，验证 probe=false、正确频道、最近成功、明确拒绝及 config-only 回退；结果不泄漏合成账户数据。该演练只读挂载当前检查源码，未把它宣称为已进入 `897f2ab` 镜像。临时容器自动清理，无业务卷、真实扫码或第二个接收器。页面脚本另验收未启用、过期、断连和未知结果。

生产完整宿主入口、真实轮询/微信验收及生产看板汇总仍待完成；当前新增模块需要在下一次候选固化时纳入镜像。

## 生产状态汇总入口

`7062851` 增加 `inspect-production-status.mjs '<不可变生产宿主目录>'`，汇总模型、账本、微信和 Tunnel 的各自状态，输出固定字段，不将本地健康等同于真实微信或公网验收。适配器只读取已核验的宿主、启用门禁、LaunchAgent 与精确 PID、维护/故障状态和三项容器身份；不会安装、启用、恢复或停止任何服务。

只有已启用、宿主状态新鲜、非维护/故障且三项服务边界健康时才运行只读授权检查。检查完成后再次核验门禁、宿主 PID、运行代次、容器及启动时间；期间切换或重启会丢弃整次结果。每项失败分别显示无法确认，其余来源保留自身验证范围。模型/账本/微信投影必须显式匹配 production profile，历史 Tunnel 状态与微信旧轮询不作为新成功。公网和真实消息接受标记始终为 false。

21 项定向测试通过，覆盖四源汇总与脱敏、维护/故障/停用不访问凭据、错误门禁/PID/代次/时效、检查中切换和重启、单源失败及旧结果拒绝。实际 `verify-production-host-inactive.mjs` 已调用新 CLI，确认未启用时返回 disabled，无生产容器、任务或门禁产生，未确认启用仍拒绝。它只覆盖真实入口的未启用路径，正向汇总使用合成适配器和既有各源探针证据；真实生产组合验收尚未执行。

该入口尚未接入生产 HTTP 看板及看板任务切换；这些仍是下一步工作。在线测试看板 `d53b535` 未改变，12:02 UTC 连续健康约 26.7 分钟、无断采，启动阶段 1 个非健康样本保留。临时测试日志与未启用演练目录均已清理。

生产 HTTP 页面与后台检查后续已在 `007b662` 实现，尚未安装；任务切换和生产正向验收仍待完成。当前操作入口及准确范围见 [生产看板](../mac-production-dashboard.md)。
