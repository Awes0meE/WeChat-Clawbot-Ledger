# Mac P0 环境盘点与原型方案

记录日期：2026-09-08，Asia/Singapore。源码基线 `7cde428b45c9b3a358e80484a1ec1c4e5107fe3f`，工作分支 `feat/mac-docker-runtime`。

## 结论与证据范围

P0 的只读环境盘点、固定版本供应检查和原型方案已形成。当前有条件进入 P1 准备，尚不具备容器实测条件：Docker 未安装，可用磁盘低于本方案预算。Linux ARM64 运行、实际加载的 Codex harness、六工具策略和重建恢复均未验收，不能将镜像可获得记作运行通过。

本轮只创建开发分支和交接记录；未安装软件、拉取镜像层、启动服务、调整电源、读取运行凭据、迁移数据或改变公网入口。联网查询包括公开源码、npm 元数据、镜像 manifest/config 和匿名 HEAD 请求。注册表匿名访问令牌只在查询进程内使用，未保存。

用户于本轮明确补充：

- Windows 仍在线，微信记账正常运行。这是用户现场确认，本轮没有远程登录 Windows 做机器核验。
- Mac 当前连接的家中 Wi-Fi 就是计划长期使用的网络；用户预计网络可持续运行，但尚无持续可用性测量。
- Mac 计划一直插电、开盖亮屏、永不自动熄屏，屏幕显示 Docker 服务器实时状态。

## 1. 本机实测

| 项目 | 结果 | 判断 |
| --- | --- | --- |
| 系统 | macOS 26.6.2，build 25G83 | 后续安装时核对所选 Docker Desktop 发行版支持条件 |
| 架构／机型 | arm64，MacBookPro17,1（M1） | 目标使用原生 Linux ARM64，未运行 Linux 容器 |
| 内存／逻辑 CPU | 8 GiB／8 | 原型暂定 Docker VM 4 GiB、2 核；按实测调整 |
| 数据卷可用磁盘 | 23,178,056 KiB，约 22.10 GiB | 是 `df` 当次可用值，不含对“可清除空间”的推算 |
| 当前电源 | 电池供电，91% | 尚未达到计划的持续插电状态 |
| 插电电源设置 | `sleep=1`，`displaysleep=20`，`womp=1` | 自动睡眠／息屏设置与常亮目标不一致；网络唤醒不能代替禁自动睡眠 |
| 电池电源设置 | `sleep=1`，`displaysleep=2` | 本轮未改；未来保留单独电池策略 |
| FileVault | Off | 没有当前 FileVault 解锁门槛；不代表 Docker 可在无人登录时启动 |
| Docker／其他运行时 | PATH 无 docker、colima、limactl、podman；常见应用目录无 Docker／OrbStack／Podman／Rancher 应用 | 没有可核验的 Docker Engine、Compose 或 Linux VM 版本 |
| Node／npm | Node v22.23.1，npm 10.9.8 | Node 满足仓库固定 OpenClaw 的 engines 范围 |
| 本机 SQLite | `node:sqlite` 内存库查询成功，SQLite 3.53.3 | 仅 darwin/arm64 本机烟测；没有打开任何磁盘数据库 |
| Git | 本地、远端 HEAD／main 同为上述基线 | 联网核对完成；随后建立开发分支 |

Docker 官方说明要求至少 4GB RAM，并支持当前及前两个 macOS 大版本。4 GiB VM 是此机的初始预算，不能视为已证明峰值足够。[安装要求](https://docs.docker.com/desktop/setup/install/mac-install/)、[资源设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)。

## 2. 旧运行环境盘点

本轮使用进程程序名、启动项中的相关程序信息和目录元数据，不输出启动参数、环境变量或文件正文中的运行秘密。

- 检查 `~/Library/LaunchAgents` 的 11 个 plist、`/Library/LaunchAgents` 的 1 个、`/Library/LaunchDaemons` 的 6 个；未匹配 OpenClaw、Clawbot、ezBookkeeping、cloudflared 或所查容器运行时。
- 当前用户 `launchctl list` 未匹配相关已加载任务；进程程序名扫描也未匹配相关服务。
- 本机 TCP `8888`、`18888`、`18789` 未发现监听者。没有为了探测而启动任何服务。
- 常见状态目录 `~/.openclaw`、`~/.clawdbot`、`~/.docker`、`~/.colima`、`~/.orbstack`、`~/.lima`、`~/.cloudflared` 均不存在。
- Docker 常见 `~/Library/Containers/com.docker.docker` 与 `~/Library/Group Containers/group.com.docker` 均不存在。
- `/Applications` 和 `~/Applications` 未发现上述容器应用。

结论仅覆盖上述常见位置、当前可见进程和指定端口，不声称全盘没有归档、备份、其他用户安装或自定义路径。没有发现需要清理的旧服务，也不能据此删除其他位置。Windows 唯一生产接收端的当前依据为用户确认及仓库交接；正式切换时仍须核验 Windows 实际服务身份。

## 3. 家庭网络检查

以下是匿名 HEAD 请求结果，未携带业务凭据、发起 OAuth、微信轮询或账本操作。TLS 校验证书正常后收到 HTTP 响应才记为可达。

| 目标 | HTTP 状态 | 本轮能证明的内容 |
| --- | --- | --- |
| `ilinkai.weixin.qq.com` | 405 | 到微信接入站点的 TLS/HTTP 通路可达 |
| `novac2c.cdn.weixin.qq.com` | 404 | 到微信 CDN 站点的 TLS/HTTP 通路可达 |
| `auth.openai.com` | 403 | 站点有响应；不能据此认为 OAuth 可用 |
| `chatgpt.com/backend-api/codex/` | 403 | 站点有响应；不能据此认为已授权模型请求可用 |
| `api.cloudflare.com/client/v4/` | 400 | API 站点可达；不证明 Tunnel 数据连接可用 |
| `github.com`、`registry.npmjs.org` | 各 200 | 源码／包源匿名访问正常 |
| GHCR、Docker Hub Registry | manifest/config 获取成功 | 精确版本镜像元数据可获得 |

微信／CDN 域名来自仓库 `src/auth/accounts.ts`。未执行家庭断网、路由器重启、Tunnel 7844 端口／协议长连或登录后的 Codex 请求。当前结论不包含 24/7 可用性或消息离线保留保证。

## 4. 固定版本与 ARM64 供应

镜像 manifest 和 config 已直接从官方注册表读取，精确摘要保存在 [P0 镜像与依赖记录](2026-09-08-mac-p0-artifacts.json)。没有下载镜像层、执行镜像或核验运行时文件清单。

| 组件 | 查到的发行物 | 状态与用途 |
| --- | --- | --- |
| OpenClaw | `ghcr.io/openclaw/openclaw:2026.8.2` | linux/arm64 存在；压缩层合计约 425.7 MiB；首选基础镜像 |
| ezBookkeeping | `mayswind/ezbookkeeping:1.6.1` | linux/arm64 存在；约 21.2 MiB；config 用户为 `1000:1000` |
| Node 辅助镜像 | `node:22.23.1-bookworm-slim` | linux/arm64 存在；约 76.2 MiB；仅辅助测试候选，不替换 OpenClaw 自带 Node |
| cloudflared | `cloudflare/cloudflared:2026.8.3` | linux/arm64 存在；约 26.4 MiB；P2 候选，未确认 Windows 在用版本，不作为已批准生产升级 |
| 官方 harness | `@openclaw/codex@2026.8.2` | npm 元数据及固定标签源码一致，依赖 `@openai/codex@0.151.0` |
| Codex 二进制包 | `@openai/codex@0.151.0-linux-arm64` | 官方 npm 元数据明确 `os=linux`、`cpu=arm64`；解包体积约 289 MiB；尚未下载运行 |

OpenClaw 的 npm integrity 与当前仓库 lockfile 相同。固定标签 Dockerfile 已将 Node 24 bookworm/slim 基础镜像固定到 digest；不应因为 Mac 已安装 Node 22 而改写它。实际镜像内 Node 精确补丁版本、harness 安装／注册路径和版本必须在 P1 容器内打印非敏感版本信息核对。

当前 Mac 没有已安装运行的 OpenClaw harness，因此“实际加载版本”仍为未验证。当前 Docker 文档描述默认镜像附带 codex，但该说明不能代替固定镜像的运行验收。若镜像不具备所需组件，则在固定镜像上安装精确官方包并锁定依赖；不改用其他 harness 或浮动 latest。[OpenClaw Docker](https://docs.openclaw.ai/install/docker)、[固定 Dockerfile](https://github.com/openclaw/openclaw/blob/v2026.8.2/Dockerfile)、[固定 harness 包定义](https://github.com/openclaw/openclaw/blob/v2026.8.2/extensions/codex/package.json)。

## 5. 原型配置决策

以下是 P1／P2 的实现方案，不是已经创建的部署配置。

### 5.1 主机与资源

- 使用 Docker Desktop Apple Silicon 版，安装时记录实际版本、Engine／Compose 版本和 VM 架构。
- 初始 VM 4 GiB RAM、2 CPU；应用仅使用云端 Codex，不启用本地模型、Kubernetes、Chromium 或 Docker-in-Docker。
- 本项目将可用磁盘 30 GiB 作为进入镜像构建与容器试运行的准备门槛，50 GiB 为更宽裕目标。这是工作预算，不是 Docker 官方硬性要求；当前约 22.10 GiB 尚未满足。由用户选择可移走的数据或独立存储，不自动清理个人文件。
- 镜像、命名卷和日志的磁盘上限在安装后按可用空间配置；避免 VM 最大磁盘容量和备份总量超过宿主可承受空间。
- OpenClaw 官方本地源码构建要求至少 6GB 内存，本机优先复用固定预构建镜像，仅构建项目必要增量。

### 5.2 网络与服务身份

- 测试 Compose 项目使用独立名称 `clawbot-test`；预留未来生产项目 `clawbot-production`。配置、卷、身份、凭据独立，测试不装载生产微信或 Tunnel 凭据。
- 固定 namespace owner 的服务名为 `origin`。P1 它运行测试 ezBookkeeping，仅监听命名空间回环 `127.0.0.1:18888`。OpenClaw 和一次性测试 CLI 使用 `network_mode: service:origin`；Gateway 只监听该命名空间的回环。
- 初版不声明宿主 `ports` 映射，不给模型容器 Docker socket，不放宽 origin、API、MCP 或 trusted-proxy 的回环限制。CLI 在命名空间内执行。共享网络不意味着共享文件卷或 PID。
- `origin` 替换必须视为整组重建：停止依赖服务，替换 owner，再重建所有网络依赖，核对健康、网络命名空间一致性后才启动接收。不能只重建 owner 然后假定旧容器自动加入新 namespace。
- P1 必须同时测试首次启动、owner 退出／重新启动、owner 删除重建和 Docker VM 重启。失败时停止依赖服务并保留数据，不自动误接宿主账本。

Compose 支持 `network_mode: service:{name}`，但文档对该选项的支持不构成上述恢复流程的验证。[Compose 服务定义](https://docs.docker.com/reference/compose-file/services/#network_mode)。

### 5.3 受控测试 profile

- 默认 production 继续精确接受 `http://127.0.0.1:8888`；显式 isolated-test profile 只接受 `http://127.0.0.1:18888`。
- profile 由操作者配置和启动前校验决定，模型工具没有开关权限。检查测试项目标记、独立路径、测试 owner／通道绑定、账本 UUID server ID `1`，并拒绝生产配置／秘密引用；标记文件本身不作为充分隔离证据。
- HTTP adapter、动态 MCP resolver、plugin manifest、配置校验及回归用例同步修改；测试 profile 不得混入生产有效配置。
- HTTP 与 MCP token 分开；六工具 allowlist 和 `tools.profile=full` 保持；原生 MCP 写交易工具仍不开放。
- 适配完成前只允许内存模拟或独立 `18888` API／MCP 探测，不能把插件集成测试改指 `8888`。

### 5.4 Linux origin 守护方案（P2）

为避免在两个不同 PID 命名空间之间猜测账本身份，P2 的 `origin` 计划作为一个受控运行单元：其 PID 1 supervisor 管理 ezBookkeeping 与自己启动的 cloudflared 子进程，OpenClaw 仅共享网络，保持自己的 PID 视图和凭据挂载。

supervisor 校验受信发布清单、实际子进程可执行文件与显式配置、监听 socket 所有者、健康 JSON 和登录页指纹；所有条件满足后才启动 Tunnel。使用只读程序／配置及受限状态目录，不依赖一个 HTTP 200 或容器标签来证明身份。账本与 Tunnel 在这个运维单元内共享受信 supervisor，属于明确的信任范围；不能声称二者拥有完全隔离的秘密访问面。实现时避免为读取跨容器进程而挂载 Docker socket 或开放宿主 PID。

持续健康退化必须关闭受管 Tunnel；信号退出、强制终止 supervisor、子进程逃逸、错误程序／配置和 namespace 重建均纳入故障测试。PID 1 终止后的容器子进程清退行为要在所用 VM／Engine 实测；不能只靠 `depends_on`、启动健康检查或 `restart` 保证关闭公网。若该方案无法满足身份和退出验证，回到 P0 方案审查，不能靠放宽网络限制通过。

P1 测试环境没有生产 Tunnel；可以在 P2 用无凭据假子进程进行生命周期故障注入。

## 6. 常亮运行与状态显示

用户选择的目标为“长期插电、开盖、屏幕常亮”。部署阶段计划单独设置插电时禁止系统自动睡眠与显示器自动熄屏，核验实际电源和生效设置；电池策略另行保留。本轮未作任何更改。常亮不等于关闭认证，不把关闭锁屏密码或自动登录作为默认方案。

状态显示作为 P2 运维交付：先用 Docker Desktop 查看容器与资源；后续提供宿主本地只读状态页，展示服务 readiness、数据采集时间、最近一次成功处理时间、CPU／内存／磁盘、备份时间与恢复状态。不显示交易正文、余额、微信身份、令牌或原始日志；数据过期必须显式显示“未知／过期”，不能保持虚假绿色。

状态页不进入六工具业务权限、不通过 Ledger Tunnel 公开，也不让浏览器或模型直接控制 Docker。若需宿主采集器读取 Docker 状态，限定为操作者侧组件，前端仅获取脱敏摘要；其本地访问和读写边界在 P2 单独验证。

Docker Desktop 的“登录后启动”不等于 macOS 启动后无人登录恢复。当前 FileVault 关闭也没有消除桌面登录依赖。初始恢复合同为：整机重启后用户正常登录，Docker 启动，再核验服务按序恢复。登录前自动恢复、合盖运行及停电后的自动开机均未承诺；用户目前不要求合盖。网络中断和凭据失效分别验证可重试与需人工登录的行为。[Docker 启动与资源设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)。

## 7. P0 检查结果与 P1 接续

| P0 项目 | 结果 |
| --- | --- |
| macOS、内存、磁盘、电源、FileVault 盘点 | 已完成 |
| 常见旧服务、状态目录、端口盘点 | 已完成；范围见第 2 节 |
| Windows 接收状态 | 用户确认正常；正式切换前仍需机器核验 |
| 当前家庭网络基础可达性 | 已完成；认证调用及 Tunnel 长连未验证 |
| 固定版本 ARM64 镜像与包可获得性 | 已完成，精确 digest／integrity 已记录 |
| Docker／Linux ARM64／harness 实际运行版本 | 未执行；Docker 未安装，转 P1 首个运行门禁 |
| 网络、测试 profile、origin 身份方案 | 已形成上述实现决策；尚未实装验证 |
| 启动第二个生产微信接收端／切换公网 | 均未发生 |

进入 P1 的顺序：

1. 准备足够可用磁盘，接上持续电源；安装 Docker Desktop 并记录版本与资源配置。
2. 只拉取固定 ARM64 基础镜像，核对 digest 与容器内 Node／SQLite／OpenClaw／官方 harness 版本；确认镜像实际包含所需插件。不得因 tag 存在跳过此步骤。
3. 完成最小测试 Compose、Linux hook 路径与受控 profile；用合成身份和独立账本验证权限、HTTP、MCP、消息关联和持久化。
4. 记录实际内存峰值、镜像解包及构建缓存体积，修正预算。官方镜像压缩层大小不等于实际磁盘占用。

本轮不运行 Windows 专用全量测试，也不宣称沿用的 856/856 Windows 历史结果在 Mac 通过。P0 文档以链接、JSON 格式、diff 和脱敏检查验证；业务回归由 P1 实际代码适配触发。
