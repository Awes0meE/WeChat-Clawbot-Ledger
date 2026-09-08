# Mac Docker 测试与生产入口

Apple Silicon Docker 原型和 Windows 到 Mac 的正式迁移均已通过。新用户可按下文建立隔离测试环境；迁移既有生产账本时，使用 [迁移合同](../../docs/mac-migration-intake.md)、[当前清单](../../docs/mac-before-windows-checklist.md) 和 [维护备份](../../docs/mac-maintenance-backup.md)。本页测试命令不会自动创建或启用正式微信接收器。全新 Mac 生产安装向导尚未验收，不能把测试初始化当作正式部署。

所有命令从仓库根目录执行。Docker Desktop 必须已启动：

```sh
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker compose -f deploy/docker/compose.test.yml build openclaw
docker compose -f deploy/docker/compose.test.yml --profile setup run --rm -T init
docker compose -f deploy/docker/compose.test.yml up -d --wait origin
node scripts/mac/bootstrap-test.mjs
docker compose -f deploy/docker/compose.test.yml up -d --wait openclaw
node scripts/mac/verify-test-host.mjs
```

初始化只接受新卷或本项目已识别的卷，不覆盖现有凭据。密码、HTTP/MCP token 和模型授权放在 `clawbot-test_*` 命名卷中，不在源码或镜像里。测试 token 有效期 7 天；已有 token 时重复 bootstrap 不创建新 session，也不会自动刷新。凭据缺失一半、过期或损坏需要单独恢复，不能靠删除卷解决。

首次模型登录由用户双击 `scripts/mac/login-test.command`，在本机终端与浏览器完成。登录后运行：

```sh
node scripts/mac/verify-test-model.mjs
docker compose -f deploy/docker/compose.test.yml --profile tools run --rm -T cli
docker compose -f deploy/docker/compose.test.yml --profile tools run --rm -T cli /opt/clawbot/docker/verify-plugin.mjs
```

第一项验证官方 Codex harness 与 GPT-5.6 Sol；第二项验证 HTTP、SQLite 去重与 MCP 可读历史；第三项用合成消息新增少量测试记录，检查跨实例绑定、确认和身份限制。上述验证不代表真实微信验收。

Linux 镜像保留固定官方 harness，并用受限适配连接本地 MCP。上游 MCP 配置模块保持原样；Windows manifest 继续使用原生 MCP。新启动策略检查六工具、固定模型、账本插件的消息/时间上下文授权，以及说明文件未被截断。

真实模型验收先停止测试 Gateway，避免两个模型运行时操作同一状态；两个探针串行运行：

```sh
docker compose -f deploy/docker/compose.test.yml stop openclaw
docker compose -f deploy/docker/compose.test.yml run --rm --no-deps cli /opt/clawbot/docker/verify-owner-model.mjs
docker compose -f deploy/docker/compose.test.yml run --rm --no-deps cli /opt/clawbot/docker/verify-channel-model.mjs --suite
docker compose -f deploy/docker/compose.test.yml up -d --wait origin openclaw
```

第一项读取真实工具报告，第二项执行六项业务、八个合成回合，并核对最终回复与当前消息的持久回执。会产生少量测试消费，没有真实微信收发。旧卷升级时，在停止测试 Gateway 后运行 `docker compose -f deploy/docker/compose.test.yml run --rm --no-deps init refresh-agent-limits`，补齐 Mac 注入限额与账本插件必需钩子能力，不重置身份和凭据。

## 本机状态页和加密备份

```sh
node scripts/mac/status-server.mjs
# 另一个终端，在没有模型测试任务运行时执行：
node scripts/mac/backup-test-state.mjs
```

测试状态页默认在 `http://127.0.0.1:18990`，只读、无外部资源，不显示账户、交易或凭据。本次部署的该端口已由生产看板占用，旧测试宿主已退役；在现有生产 Mac 上不要再启动同端口测试页面。新测试主机可按本节设置。

备份会核验测试容器/卷身份，暂停两个服务，把七卷全部内容形成一致快照，以 AES-256-GCM 加密保存到本机 `~/Library/Application Support/Clawbot/backups/`。密钥单独保存在同级 `backup-keys/`，权限仅当前用户；不输出或提交密钥。加密认证通过后恢复到新建的无网络验证卷，对比文件哈希/权限和两库全部表，最后清理本次验证卷并恢复测试服务。不会覆盖源卷或任何生产目标。

仅具有 `verified.json` 的备份才完成恢复演练。失败留下明确阶段与未完成文件，先检查原因，不能把未完成包当作有效备份。本节入口只备份本机测试项目；预算为 20 GiB，主机预留至少 10 GiB，并估算归档和离线恢复的双份占用；满额报错，不自动删除历史副本。真实九卷生产备份及异机恢复使用独立的 [维护入口](../../docs/mac-maintenance-backup.md)，本次迁移已另行验证。

## 重启和恢复检查

```sh
node scripts/mac/verify-test-recovery.mjs
```

此脚本会短暂停止本测试项目，先后测试 origin 停止/启动、origin 与 Gateway 删除重建、Docker Desktop VM 重启。运行前检查容器、命名卷和镜像身份；VM 重启前如果发现其他运行中的工作负载则拒绝继续。完整账本与 receipt SQLite 的表结构、行数和内容哈希在每个恢复步骤比较，随后重放固定合成消息验证没有重复记账。不会删除卷或恢复数据库。

上述脚本是显式恢复演练。另有已安装主机服务自动恢复的独立验证 `node scripts/mac/verify-host-service.mjs`，本次约 22 秒恢复且数据不变。需要手动恢复时，先进入维护模式再执行：

```sh
docker compose -f deploy/docker/compose.test.yml up -d --wait origin openclaw
node scripts/mac/verify-test-host.mjs
```

若 origin 被替换，必须通过同一 Compose 文件重建依赖的 Gateway，不能让它保留旧网络命名空间。不要使用 `down -v`、volume prune 或删除 Docker 虚拟磁盘来处理故障。启动失败时保留数据和错误状态，先检查原因。

## 平台回归

```sh
node scripts/run-portable-tests.mjs
```

Mac 子集明确排除依赖 PowerShell、Windows ACL 和计划任务的文件；默认 `npm test` 仍保留 Windows 完整测试。不能将 Mac 子集结果或旧 Windows 发布结果描述为本次跨平台全量通过。

## Linux 守护与生产构建

`deploy/guard/` 固定 cloudflared 2026.8.3 ARM64 哈希，守护验证实际 origin 进程、socket owner、只读配置和健康；子发布器受 Linux parent-death SIGKILL 保护。

```sh
docker build --platform linux/arm64 -f deploy/guard/Dockerfile -t clawbot-guard-test:p2 .
node scripts/mac/verify-guard-test.mjs
```

这是隔离本地替身发布器的故障测试，不会连接生产 Tunnel。固定 cloudflared 的真实离线 ingress 检查另有验收；公网 API/MCP 拒绝边界须切换时复验。

生产使用同一 Dockerfile 的 `production` target，不能用默认测试 target。干净提交后运行 `node scripts/mac/publish-production-images.mjs`，构建带源码提交标签的两个镜像，在仓库外生成引用内容 digest 的 Compose 和源文件哈希清单。此步骤仅发布本机产物，不创建生产卷、不启动服务、不连接 Tunnel。

生产运行需先导入九个明确命名的外部卷，并生成只读配置与停机回执；`compose.production.yml` 只是模板。`guard-config` 保存 policy 和 activation，`runtime-config` 保存 OpenClaw JSON，`tunnel-config` 保存单域配置和专用凭据，其余卷保存账本/附件、两个运行时状态、完整回执数据库和独立 HTTP/MCP token。原 `secret_key`、所有 SQLite 表及微信游标不可丢失。每个新迁移批次都应先在 Windows 核验真实文件布局与认证可迁移性，再使用现有导入器；不依据模板猜路径搬生产数据。

## 主机服务发布与维护

`publish-host-service.mjs` 从干净提交制作只读副本、镜像内容身份和 LaunchAgent 配置；`host-service.mjs` 在用户登录后提供状态页并每 15 秒检查隔离服务。Docker 未启动时等待；已识别服务异常时按顺序恢复，重试间隔至少五分钟。主机立即可用低于 5 GiB 时受控停止测试服务，低于 10 GiB 时不尝试恢复；未知身份/namespace 变化需要人工核验。

此服务管理隔离测试项目，不能视作生产自动接管器。生产启用须在 Windows 停机和 Mac 导入之后，按最终产物部署验证。

备份、模型探针、恢复与守护测试共用 `~/Library/Application Support/Clawbot/operations/clawbot-test.lock`。不要手工并行执行绕过锁的 Compose 写操作。调试前可以创建同目录的 `maintenance` 文件，让主机服务只报告维护状态；完成身份核验后移除该维护标记。残留操作锁不自动删除，先查 owner PID 和相关 Docker helper，确认没有任务后再恢复。

LaunchAgent 的登录依赖见 [Apple 官方说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。Compose 的启动顺序和运行期恢复是不同能力，见 [Docker 官方说明](https://docs.docker.com/compose/how-tos/startup-order/)。目前不承诺整机断电后无人登录恢复。

出站断网恢复可运行 `node scripts/mac/verify-test-network.mjs`。它先核验网络仅有一个测试 origin，断开/重接其 Docker bridge 接口，在进程内只检查无授权外站是否可达以及回环账本是否保留，最后再次核验宿主隔离。它不改变 Wi-Fi，也不证明真实微信离线补收。
