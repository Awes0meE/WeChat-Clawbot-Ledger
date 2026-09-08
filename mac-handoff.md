# Mac Docker 移植交接

更新于 2026-09-08，时区 `Asia/Singapore`。

本文保留 Windows → Mac Docker 的原设计与切换判据，下面的阶段描述是准备期历史基线。2026-09-09 已完成正式 Mac 接管、真实业务验收、最终异机备份和旧实例退役；当前版本及适用边界见 [Mac 工作清单](docs/mac-before-windows-checklist.md) 和 [正式切换记录](docs/handoffs/2026-09-09-production-cutover.md)。

迁移目标是保留现有记账行为、身份限制、去重、可信回复和网页入口，使日常操作不再依赖 Windows 开机。24/7 是运行目标，不代表单台笔记本能承诺零中断；整机重启、磁盘解锁、网络故障和服务恢复必须分别验收。

初次 P0 记录：本交接经 PR #9 合入 `main` 的 `7cde428`；当时 Docker 未安装、立即可用磁盘约 22.10 GiB。这些是历史盘点值。之后已安装 Docker、完成实际 harness/P1 验证、登录后宿主更新与回退，现状态页运行 `9478540` 并开始连续采样。用户确认 Windows 继续正常记账；Mac 使用家中 Wi-Fi、长期插电开盖亮屏。未切换生产服务。下文原始分支获取步骤仅保留交接背景，继续开发使用现有 `feat/mac-docker-runtime`，先核验远端和工作区，不重复建分支。

## 1. 接手先看什么

按以下顺序读取，避免把历史设计或本文件中的设想当作已上线事实：

1. [项目 AGENTS.md](AGENTS.md)：当前生产合同和操作边界。
2. [README](README.md)：系统功能、架构、测试入口。
3. [Windows 交接](WINDOWS-HANDOFF.md)：现有模型、工具和运行契约。
4. [最新发布记录](docs/handoffs/2026-09-07-numbered-canteen-fix.md)。
5. [Ledger 运维手册](docs/ledger-cloudflare-runbook.md)：发布、隔离、备份、公网和回滚要求。
6. 本文件：Mac 目标架构、开发顺序和完成判据。

先确认远端最新提交和 Mac 工作区状态；本文件的源码基线为 `573d81d`，正式业务 release 为 `1ab154fca487154fb07def1be31ca44faaa7c4a7`。后续若有更新，以最新项目记录和实际探测为准。不要依赖这份交接永久判断实时服务状态。

本仓库远端是 `Awes0meE/Clawbot`。Git 只提供源代码、测试和脱敏配置，不提供已登录的微信、Codex、Cloudflare 或已有账本。旧 Mac 接收端在先前切换到 Windows 时已停止；Mac 上是否残留旧 LaunchAgent、容器、数据和登录状态需要先只读盘点，不能按名称直接删除或启动。

### Mac 获取本次交接

本次交接使用远端分支 `docs/mac-docker-handoff`。准备交接时远端 `main` 为 `3488095`，尚未包含本机已上线的食堂编号修复及其发布记录；交接分支保留 `573d81d` 的完整源码基线，再新增本文。不要只同步当时的 `main`，否则代码与本文所述生产基线不同。

在已克隆的 Mac 仓库里先运行 `git status --short --branch`，确认没有需要保留的未提交工作，然后：

```bash
git fetch origin
git switch --track origin/docs/mac-docker-handoff
git switch -c feat/mac-docker-runtime
```

上述命令适用于两个本地分支都尚不存在的首次接手。若已存在，先检查对应分支内容和进度，再切换／快进更新；不要使用 reset、强制覆盖或清空工作区来同步。尚未克隆时先通过自己的 GitHub 授权克隆 `https://github.com/Awes0meE/Clawbot.git`。本文不包含运行所需凭据或生产数据。

## 2. 设计时的仓库与生产系统

```text
微信 iLink（主动长轮询）
  -> Windows OpenClaw 2026.8.2
  -> 官方 @openclaw/codex 2026.8.2 / Codex harness
  -> OpenAI gpt-5.6-sol（ChatGPT OAuth，thinking low）
  -> clawbot-bookkeeping
  -> http://127.0.0.1:8888 ezBookkeeping 1.6.1

浏览器 -> ledger.66ccff-labs.com -> Cloudflare Tunnel
  -> Windows origin 身份与健康守护 -> 同一个正式账本
```

Windows-only 指本地服务都在 Windows，不是本地大模型推理。模型请求及回复需要的查询结果进入当前已授权的 OpenAI Codex 会话；迁到 Mac 后这条云端依赖保持不变。微信接入使用腾讯网络接口，不依赖桌面微信窗口、鼠标或屏幕捕获。

### 2.1 模块职责

| 路径／服务 | 当前职责 | 移植原则 |
| --- | --- | --- |
| `openclaw-plugins/openclaw-weixin-stable-id/` | 保留上游消息 ID、发送者，执行接入授权，持久化轮询游标 | 保留项目补丁，不能换成未修改的上游插件 |
| `openclaw-plugins/clawbot-bookkeeping/index.ts` | OpenClaw hook、可信消息关联、工具注册、回复发送协调 | 保持业务行为，调整路径和必要的平台接口 |
| `bookkeeping-core.mjs`、`categories.mjs` | 金额、币种、时间、分类、确认和写入规则 | 原则上复用现有规则与回归用例 |
| `adapter.mjs` | HTTP API 与本地 SQLite 状态存储 | 保留去重、事务和超时语义 |
| `expense-summary.mjs`、`expense-search.mjs`、`expense-history.mjs` | 确定性汇总、金额搜索、历史明细验证及排版 | 维持结果来源与显示契约 |
| `mcp-connection.mjs`、`openclaw.plugin.json` | owner-only 动态 MCP 与固定 origin | 不增加静态凭据或任意网络地址后备 |
| `openclaw-workspace/` | 专用 bookkeeper 提示词与行为合同 | 正式使用只读发布内容，运行数据另存 |
| `openclaw-hooks/session-memory/` | 避免 bookkeeper 的会话记忆写入不可变 workspace | 增加经验证的 Linux 入口适配 |
| `scripts/*.ps1` | Windows 安装、发布、任务、Tunnel 和验收 | 保留 Windows 入口，另建 Linux／Mac 实现 |
| ezBookkeeping | 账户、分类、交易、附件和原生网页登录 | 保留现有数据与配置语义 |

表中简写的 `.mjs` 文件均位于 `openclaw-plugins/clawbot-bookkeeping/`。

### 2.2 行为和数据合同

- 固定一个所有者、一个 SGD 支出账户、`Asia/Singapore` 时区；不在此次移植扩展多人、多账户或多币种。
- 模型解释语义，本地插件验证和读写。只有 API 明确确认交易创建，才能发送成功回执。提交结果不确定时不能盲目重试。
- 一条可信入站消息最多一笔支出；按可信通道与上游消息 ID 去重，不能按消息文字去重。
- 信息完整但有疑问时先生成确认单；确认、取消、过期和新话题替代必须保持原行为。
- 历史明细限定固定账户、最多十行、验证分页，不能直接把原始 JSON 发到微信。
- 新消息优先，旧回复或延迟提案不得覆盖新请求。保留当前消息来源键和相关持久状态。
- 微信插件在上游缺少消息 ID 时会退回随机 ID；这种情况不能保证平台重放仍有稳定键，不能宣传绝对 exactly-once。

专用代理保留 `tools.profile=full` 与以下六项精确 allowlist：

```text
record_expense
prepare_expense
resolve_expense_confirmation
summarize_expenses
find_expenses
ezbookkeeping__query_transactions
```

`minimal` 基础 profile 会先过滤原生 MCP 工具；不能只复制 allowlist 却改回 minimal。原生 MCP `add_transaction` 不在允许范围。HTTP token 和 MCP token 必须分开，MCP 连接仅在可信所有者请求时动态构造。

### 2.3 运行隔离与已有证据

- 正式账本：`127.0.0.1:8888`；隔离测试：`127.0.0.1:18888`；Gateway：`127.0.0.1:18789`。
- 正式 OpenClaw 加载仓库外的不可变、完整哈希校验 release；编辑 Git checkout 不等于部署。
- Windows 账本和 Tunnel 使用登录后启动的后台任务；OpenClaw 保留自己的隐藏启动方式。
- 2026-09-07 会话内只读探测确认两个账本健康、上述端口只监听回环，实际 release 为 `1ab154f...`。这不是 2026-09-08 重新执行的服务验收，也不是 Mac 实测。
- 最新发布记录报告完整回归 856/856、最终针对性检查 229/229、切换后严格本机 14/14 与公网验收通过。这些是当次 Windows 发布证据。
- 食堂编号修复没有新的真实微信端到端验收；较早聊天验收见 [系统检查记录](docs/handoffs/2026-09-07-bookkeeping-system-audit.md)。真实平台同消息 ID 重放仍缺验收证据。

## 3. Mac 运行目标与资源判断

### 3.1 技术可行性

OpenClaw 有官方 Docker 和 Linux ARM64 构建路径；Codex 有 Linux ARM64 发行目标；ezBookkeeping 发布流程包含 Linux ARM64；cloudflared 也有 ARM64 版本。自有插件主要使用 Node.js、HTTP 和 SQLite，因此架构上可迁移。

但“上游支持 ARM64”不代表本文固定版本及项目插件组合已通过验收。首个原型必须验证实际镜像 manifest、Node `node:sqlite`、官方 Codex harness、六工具策略和动态 MCP。首次移植尽量保持 Windows 的版本组合；若固定版本没有合适镜像，应构建固定版本的派生镜像，或单独评估升级，不能直接改为浮动 `latest`。

### 3.2 M1 8GB／256GB

个人低并发记账不需要本地模型权重，M1 的 CPU 足够承担预期工作。建议初始给 Docker VM 4GB 内存、2～4 核，并给 macOS 留出余量；至少预留约 30～50GB 可用磁盘用于镜像、升级缓存、日志和备份。这些是容量预算，需以 Mac 上实测的峰值、交换内存和磁盘增长修正。

优先使用固定版本的预构建 ARM64 基础镜像，仅加入必要插件和运行依赖。OpenClaw 官方 Docker 文档要求本地源码镜像构建至少 6GB RAM，8GB Mac 不宜把完整上游源码构建作为常规运行步骤。不要为当前六工具账本额外启用 Chromium、Kubernetes、本地模型或 Docker-in-Docker。

### 3.3 “24/7”需要完成的主机工作

| 情况 | 目标行为／验收要求 |
| --- | --- |
| 正常日常运行 | 插电、息屏、锁屏后消息接收和网页持续可用 |
| 自动睡眠／合盖 | 明确配置防止整机睡眠；合盖单独实测，不能用“唤醒以供网络访问”代替常驻进程能力 |
| 单进程或容器退出 | 受控重启，等待真实 readiness，保留全部持久状态 |
| Docker VM／Desktop 重启 | 服务按正确顺序恢复，不出现重复接收器、遗留 Tunnel 或错误 origin |
| macOS 整机重启 | 明确 Docker 的登录依赖；启用 FileVault 时确认是否需要人工解锁。没有实测无人登录恢复，不能写“断电后全自动恢复” |
| 家庭断网／路由器重启 | 恢复后继续轮询，验证游标和去重；不承诺上游无限期保存离线消息 |
| 凭据过期 | 明确区分需重新授权和可重试故障，避免无限重启掩盖登录失效 |
| 磁盘不足／备份失败 | 有可观察的告警或状态，停止不可靠写入，不自动删除未知数据 |

建议先采用 Docker Desktop 的受支持 macOS 版本。它在 macOS 上通过 Linux VM 运行容器，容器 `restart` 策略无法使尚未启动的 VM 自动运行。若用户要求整机重启后无须任何登录，应先做主机恢复原型；必要时再比较可由系统服务管理的 Linux VM／容器运行时，但不要假定替换 Docker Desktop 就绕过了磁盘解锁要求。

家中网络需要持续访问腾讯 iLink、OpenAI、Cloudflare 和镜像源。正式网页继续通过 Tunnel，不需要公网 IP 或路由器端口转发。准备仓库外的加密离机备份；Docker volume 本身不是备份。

## 4. 建议技术路线：先保持业务合同，再替换平台层

### 4.1 候选部署结构

```text
MacBook Pro M1 / macOS
  └─ Linux ARM64 Docker VM
      ├─ 生产 Compose 项目（完成开发后才接管）
      │   ├─ 固定的网络命名空间
      │   ├─ OpenClaw + 官方 Codex harness + 两个项目插件
      │   ├─ ezBookkeeping：127.0.0.1:8888
      │   └─ origin 守护 + 它管理的 cloudflared
      │       对外只提供 ledger.66ccff-labs.com
      └─ 开发／测试 Compose 项目
          ├─ 独立网络、配置、登录、密钥和数据卷
          ├─ 测试账本：127.0.0.1:18888
          └─ 默认不接生产微信、不启生产 Tunnel
```

这是目标结构，不是现成的 Compose 文件。共享网络命名空间不等于共享文件卷或授权，也不会自动共享 PID 命名空间。

### 4.2 网络是首要设计点

当前 `adapter.mjs`、`mcp-connection.mjs` 和插件 manifest 均限制生产 origin 为 `http://127.0.0.1:8888`。普通 bridge 网络中，各容器的 `127.0.0.1` 互不相通；改成 `http://ezbookkeeping:8888` 会被代码拒绝。

第一版优先验证 Compose `network_mode: service:<namespace-owner>`：让生产 OpenClaw、账本和受控 Tunnel 共享一个固定网络命名空间，继续通过 loopback 通信。namespace owner 的选择、替换时依赖容器如何重建、启动顺序和故障恢复须形成测试，不能只证明首次启动可用。

仍须保持以下条件：

- 生产 origin、API token、MCP 和 trusted proxy 的回环限制不放宽到任意 Docker 网段或 `0.0.0.0/0`。
- 不发布账本 origin 到局域网或公网；不挂载 Docker socket 给 bookkeeper 或模型工具。
- Gateway 保持其命名空间内回环监听。普通 `ports` 映射不能直接解决“服务只绑容器 loopback”的访问问题；初期管理可在命名空间内执行 CLI，后续如需宿主本地管理入口，另行设计和验证其仅回环可达性。
- 通过实际请求确认 Cloudflare 传递的客户端地址和代理信任语义；公网携带有效 API／MCP token 仍须被拒绝，不能因为所有容器都走回环就误放行公网调用。
- 不把 `network_mode: host` 当作 macOS 原生本机网络的无条件替代。

如果共享命名空间方案无法满足守护与恢复要求，再评估私有 bridge 网络。这一备选会同时改变 origin 校验、MCP manifest 和 allowlist 合同，需独立审查和更新项目规范；不能仅通过扩大 IP 白名单使测试通过。

### 4.3 测试端口的现有缺口

现有测试账本确实使用 `18888`，但生产插件的 HTTP／MCP 构造器只接受 `8888`。现有模拟测试和测试 CRUD 脚本不能证明“整个插件直接连接 18888”已经可行。

建议为 Mac 原型增加受控部署 profile：默认 production 仍精确限定 `8888`；明确启用的 isolated-test profile 只接受 `18888`，且核验独立数据目录、凭据、owner／通道及测试实例标记。同步修改 HTTP 校验、动态 MCP resolver、manifest 和相关测试，不能只改其中一个文件或向模型暴露模式开关。测试 profile 不得进入生产 release 的有效配置。

在这项适配完成之前，仅运行内存模拟业务测试及独立 `18888` API／MCP 测试。**不要为了绕过地址校验把集成测试改指正式 `8888`。**

### 4.4 Linux 平台与发布适配

- 路径：显式设置 `stateDbPath`、token、workspace、插件和数据库路径；移除对 `D:\Clawbot`、`APPDATA` 和 Windows npm-global 布局的默认依赖。容器路径固定，不跟随 Mac checkout 位置变化。
- Node：根据固定 OpenClaw 版本选择支持的精确 Node 版本；当前 README 的范围为 `>=22.22.3 <23`、`>=24.15.0 <25` 或 `>=25.9.0`。ARM64 容器内重新安装锁定依赖，不能复用 Windows `node_modules`。
- session-memory hook：当前 `handler.js` 遇到非 `win32` 会直接报错。保留版本和上游哈希核验、只跳过 bookkeeper 的语义；增加 Linux 安装定位，并证明实际 hook 注册和工作区不被运行时改写。
- 发布：新增 Linux ARM64 构建／验证入口，固定镜像 digest、依赖与源码提交，运行内容只读，业务状态写独立 volume。只读挂载不能替代发布身份验证；保留可核验的版本清单和旧镜像回退。
- 权限：为每个服务设置固定 UID/GID 和最小目录权限，秘密不进入镜像层、Compose 明文、Git 或构建日志。分别挂载所需凭据，避免所有容器共享所有秘密。
- 现有 Windows 脚本继续保留；本次移植不改变 Windows 生产部署方式。

### 4.5 Tunnel 守护必须具有等效行为

Windows 守护使用进程路径、显式配置、监听 owner、健康 JSON、页面指纹，以及 Win32 Job Object 控制自己的 cloudflared。Linux 容器不能直接运行这些 Win32 检查。

需要实现 Linux origin 验证和子进程管理：检查固定程序／镜像及配置身份、实际监听和健康；异常时关闭自己启动的 Tunnel，恢复条件满足后才重新发布；守护自身崩溃或被终止也不能遗留可对外服务的 Tunnel。

共享 network namespace 后，守护不一定能看到另一容器的 PID。必须明确采用受限共享 PID 视图、origin 侧身份验证接口或经过论证的等效机制，写出它能证明和不能证明什么。不能仅把“HTTP 200”当作预期账本身份，也不能通过给容器完整 Docker 管理权解决进程查询。

`depends_on`、启动时 `service_healthy` 和普通 `restart` 策略不保证运行期健康退化后自动关闭其他服务。故障注入至少覆盖错误 origin、错误配置、健康失败、账本停止、守护退出和网络命名空间重建。

## 5. 必须迁移的持久数据

| 数据 | 处理要求 |
| --- | --- |
| ezBookkeeping 数据库 | 使用 SQLite 一致快照；运行中不能只复制主 `.db` 而遗漏 WAL 中的有效数据 |
| 附件／storage | 与对应数据库版本一起备份、迁移和校验 |
| ezBookkeeping 配置及原有 `secret_key` | 保持原有认证和数据语义，不能按“全新安装”随手重建密钥 |
| 插件状态 SQLite | 整库一致迁移；不能只搬交易或清空去重表 |
| API token、独立 MCP token | 受限传输，分别挂载；不可进入模型上下文或 Git |
| 微信账户、配对和同步游标 | 停止旧轮询器后迁移，保持消息身份与恢复位置；目标登录失效时由用户交互授权 |
| OpenClaw／Codex 必要状态 | 按固定版本支持的方式迁移或重新授权；处理路径、文件权限和可能的系统凭据存储差异，不能假定复制整个目录即可 |
| Tunnel 配置与专用凭据 | 保留 Ledger-only 路由；迁移时保证旧 connector 停止，避免请求分流到两份数据库 |

插件状态至少包含 `message_receipts`、`processed_expense_confirmations`、`ended_trusted_runs`、`receipt_store_migrations`，以及可信入站、待确认、待发送权威回复、`trusted-inbound-freshness-v1` 的消息历史／最新来源状态。**以迁移时完整数据库 schema 为准，上述名称不是允许省略其他表的白名单。**

先等待在途请求结束，再取得账本和插件状态相互对应的一致快照。保留持久化去重记录；过期提案和短期关联由既有逻辑处理，不手工删表“清理状态”。

运行数据放 Docker 命名卷或明确的本地持久目录，不放 Git checkout、iCloud／OneDrive 同步目录或共享网络盘。外部备份独立加密，恢复流程先在隔离环境演练。仓库中的 `testAccountInfo.txt` 若存在，仍遵守 AGENTS.md 的禁读、禁输出、禁提交边界。

## 6. 建议开发阶段与交付物

以下保留原阶段判据；已实现部分链接到实际证据。每个完成验证的部分单独提交 Conventional Commit，正式切换和真实观察仍需各自证据。

### P0：环境盘点与方案确认

- [x] 记录 macOS、磁盘、Docker/ARM64；家庭网络由用户说明并有本机出站验证。
- [x] 只读盘点旧 Mac 状态，未启动旧接收端；Windows 正常生产由用户确认，远程核验留到交接。
- [x] 验证固定 ARM64 依赖、镜像 digest 与实际 harness 版本。
- [x] 写明锁屏与整机重启恢复的区别；2026-09-08 整机重启后人工登录恢复和两库一致已通过；无人登录恢复未验收。
- [x] 确认共享 namespace、测试 profile 和 origin 身份验证方式。

完成判据：有一份脱敏环境记录及明确的原型配置方案；未启动第二个生产微信轮询器、未切换公网。

### P1：最小 ARM64 原型

2026-09-08 P1 已通过，详见 [P1 历史验收](docs/handoffs/2026-09-08-mac-p1-progress.md)。用户选择固定 OpenClaw 2026.8.2 与受限 MCP 适配，实际六工具及八回合合成消息链已通过，官方 harness 保持原样。P1–P6 的 Mac 独立准备已完成，三小时观察和最终恢复资料已通过，见 [最终回执](docs/handoffs/2026-09-08-mac-preparation-complete.md)；具体当前状态统一见 [Mac 工作清单](docs/mac-before-windows-checklist.md)。本节及后续阶段清单保留原验收范围，不把工具演练写成正式迁移。Windows 仍在线，真实数据、身份和 Tunnel 未切换。

- [x] 新增 Dockerfile、隔离 Compose、构建白名单和脱敏模板。
- [x] 构建排除状态、秘密、备份和真实会话；镜像不带生产数据。
- [x] Linux 路径、session-memory hook、受控测试 profile 与必要消息钩子授权。
- [x] `18888` HTTP、独立 MCP 及受限适配的可读历史。
- [x] 官方 Codex harness、实际六工具、完整合成消息来源与最终回复链。
- [x] 请求/空闲资源采样、容器重建和 VM 重启后的显式恢复；长期观察仍在 P4。

完成判据：ARM64 上最小业务链成立，权限边界成立，重建不丢数据；记录未覆盖的真实微信范围。

### P2：可维护部署与运行期守护

- [x] 已新增生产 Compose 与不可变 ARM64 镜像发布；同版本恢复选择/失败回退已实测。
- [x] 固定上游下的生产代码/镜像更新、源码绑定调整及维护回退已实现，并有合成数据/三服务演练；具体生产版本兼容性和正式执行仍留到部署。
- [x] 实现 origin 身份验证、Tunnel 子进程生命周期及持续 fail-closed（隔离替身故障矩阵通过，正式公网待切换验收）。
- [x] 配置只读发布、分离状态卷、UID/GID、受限秘密、日志轮转、健康与 readiness。
- [x] 服务启动顺序、namespace owner 替换、Docker VM 重启、有限 tmpfs ENOSPC/SQLITE_FULL 和测试出站网络恢复通过；不等于物理磁盘损坏或真实生产重连验收。
- [x] 新增 `scripts/mac/backup-test-state.mjs` 等，七卷加密备份、恢复及完整数据校验通过。
- [x] 保留 Windows 验证路径，明确分组跨平台、Windows 专用和 ARM64 集成用例；本机排除 11 个 Windows 文件，不称全平台回归。

完成判据：隔离环境故障注入通过，镜像／配置／数据可追溯，恢复不会误接旧账本或放宽公网权限。

### P3：正式迁移准备与切换

- [ ] 形成精确的数据和配置清单、受限传输方案、旧服务身份清单、切换步骤与回滚条件。
- [ ] 在用户确定正式迁移窗口后，暂停 Windows 微信接收及账本网页写入入口，等在途业务结束；必要时进入明确停服窗口。
- [ ] 制作最终一致快照并验证 `quick_check`、表／记录计数、已有持久去重记录与附件校验；不输出交易正文或身份信息。
- [ ] 导入 Mac 并验证；先停已识别的旧 Tunnel，再启用目标 Tunnel，保证同域名不指向两份可写数据。
- [ ] 停止旧生产轮询器后，才允许 Mac 接管同一微信账号。保留旧端备份，但不能双端并行接收。
- [ ] 用户在可见界面完成必要登录和真实微信验收；不通过聊天传递 token、OAuth 回调、二维码内容或密码。
- [ ] 验证账本、历史查询、公网限制、DNS／作品集不变，并更新 `AGENTS.md`、`README.md`、`WINDOWS-HANDOFF.md`、本文件和新的实际部署记录。

当前“在 Mac 尝试开发”不等于已执行生产切换。开发阶段继续保持 Windows 在线；只有实际切换完成并通过验收，才把文档状态改为 Mac 生产。

### P4：持续运行观察

- [x] 按用户 2026-09-08 最新要求，连续约三小时隔离低负载观察已通过，见 [实测记录](docs/handoffs/2026-09-08-mac-three-hour-observation.md)；本轮等待结束并进入下一步；不再等待 24～48 小时。记录请求、内存峰值、磁盘增长和错误恢复，隔离测试结果与切换后真实业务证据分开。
- [ ] 分项主机恢复：2026-09-08 手动锁屏连续 90.871 秒及解锁、测试出站网络恢复、Docker/VM 和整机重启后人工登录恢复已通过；独立息屏/合盖未执行，实际生产网络与微信恢复仍待。见 [锁屏记录](docs/handoffs/2026-09-08-mac-lockscreen-check.md)。
- [x] 七卷测试备份与九卷合成备份/历史恢复已通过，仅恢复新卷，不自动覆盖正式数据库。
- [ ] 为仍需人工解锁或重新登录的情形留下明确恢复步骤；没有闭合的恢复项继续列为限制。

## 7. 最终验收矩阵

| 范围 | 需要的证据 |
| --- | --- |
| 版本和运行身份 | 固定 ARM64 镜像、源码提交、依赖、hook、实际加载路径一致 |
| 工具与所有者 | 实际只暴露六项工具；其他发送者无写入和 MCP 连接权限 |
| 明确支出 | 分类、SGD、备注、日期、餐段、食堂编号、加法金额保留现有语义 |
| 确认流程 | 确认／取消、过期、新话题、重复确认和重启后确认正确 |
| 去重和回复 | 重复消息不二次写入、同文本不同 ID 可区分、旧回复不覆盖新请求、跨实例有效 |
| 查询 | HTTP 汇总、精确金额搜索、MCP 历史、分页、十行限制及错误文案正确 |
| 持久化 | 容器删除重建和 VM 重启后，交易与完整插件持久状态保留 |
| 公网边界 | 原生账本登录；注册和密码找回关闭；API／MCP 有效 token 公网调用仍拒绝；只有 Ledger hostname |
| fail-closed | 错误 origin／配置、健康退化、守护退出都不能遗留对外通路 |
| 主机恢复 | 锁屏、息屏、合盖策略、断网、Docker 和整机重启有分项证据 |
| 数据切换 | 只有一个生产轮询器、一份权威可写账本，迁移前后状态核对一致 |

真实平台重放需要实际触发和证据；模拟相同 message ID 的测试不能替代。公网携带有效凭据的检查应按既有 runbook 在明确验收范围内执行，凭据只在本机进程内使用。

## 8. 回滚与开发范围

首次目标是“同一套业务换到 Linux ARM64 容器”，不同时更换模型、数据库类型、公开域名或记账规则。SQLite 数据文件跨平台迁移不要求引入 PostgreSQL／MySQL；如未来需要数据库升级，单列项目，避免与主机迁移叠加。

正式切换后，如果 Mac 尚未产生新写入，可以在验证状态一致后按计划恢复旧端。如果 Mac 已有新增交易、确认处理或去重状态，必须先停止目标写入并核对增量，再制定反向迁移；**不能直接重启旧 Windows 数据库当作无损回滚**。恢复数据库不得自动执行。

不要清理旧主机、旧账号或未知服务；不要把备份、日志、真实消息、token 和 SQLite 推到任何仓库。Cloudflare 继续只服务 `ledger.66ccff-labs.com`，不添加 Access，不改 `66ccff-labs.com`／`www.66ccff-labs.com`。

Mac 接手后的第一步是 P0，然后完成 P1；不要直接运行 Windows 生产安装脚本、启动旧 Mac 接收器或复制生产配置后立即启动整套容器。开发分支建议使用 `feat/mac-docker-runtime`；若同名分支已存在，先检查其进度，不覆盖已有工作。

## 9. 官方参考资料

这些资料用于平台可行性与运行条件参考，可能随上游更新。具体开发以固定版本源码、镜像 manifest 和本机验证为准，不直接套用官方示例中较宽松的端口发布或凭据配置。

- [OpenClaw Docker：ARM64、镜像构建、持久化和容器登录](https://docs.openclaw.ai/install/docker)
- [OpenClaw 官方 Codex harness](https://docs.openclaw.ai/plugins/codex-harness)
- [Codex 官方平台目标](https://github.com/openai/codex/blob/main/scripts/codex_package/targets.py)
- [ezBookkeeping Docker：数据、附件、权限和配置](https://ezbookkeeping.mayswind.net/installation/installation-docker)
- [ezBookkeeping ARM64 发布流程](https://github.com/mayswind/ezbookkeeping/blob/main/.github/workflows/build-release.yml)
- [Docker Desktop Mac 要求](https://docs.docker.com/desktop/setup/install/mac-install/)
- [Docker Desktop 资源和登录后启动设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
- [Compose 服务与 network_mode](https://docs.docker.com/reference/compose-file/services/)
- [Compose 启动顺序与健康依赖](https://docs.docker.com/compose/how-tos/startup-order/)
- [Apple 睡眠与唤醒设置](https://support.apple.com/en-gb/guide/mac-help/mchle41a6ccd/mac)
- [cloudflared ARM64 与 Docker](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
- [Cloudflare Tunnel 副本机制](https://developers.cloudflare.com/tunnel/configuration/)
