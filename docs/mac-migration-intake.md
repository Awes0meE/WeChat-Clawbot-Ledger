# Mac 离线迁移导入合同

2026-09-09：真实 Windows 最终停服包已导入 Apple Silicon Docker，Mac 已正式启用。执行结果见 [正式切换记录](handoffs/2026-09-09-production-cutover.md)；下述合同仍适用于新的迁移批次，不能用本次停机证据替代另一台机器的实际核验。

## 来源与目录

接续时先核验 Windows 的实际服务、发布、路径、数据和认证存储，再制作映射。原始最终备份必须完整保留、单独计算 SHA-256。规范化包只从该备份生成；不得修改唯一原件。包放在 Mac 用户私有的 `~/Library/Application Support/Clawbot/imports/<批次>/`，不进入 Git、聊天或公开网盘。

格式为目录而非自动解压的归档：根部 `manifest.json`，文件在 `payload/<role>/`。九个角色是 ledger-config、ledger-data、runtime-config、guard-config、tunnel-config、openclaw-state、codex-state、receipts、secrets。每个目录及文件均逐项登记；文件包含字节数和 SHA-256。格式和预算以 `deploy/docker/migration-format.mjs` 为准，未知文件不能被静默跳过。

清单记录原 Windows 提交、原始最终备份哈希、原账本 secret_key 的哈希、来源时间、三项已停服声明，以及目标 Mac 提交和切换 UUID。最终停服声明必须在实际停止旧接收器、旧 Tunnel 和账本写入后生成。合成包只能用于 rehearsal，production 模式拒绝它。

两库审计包含完整 schema、每张表的全部记录、索引/触发器/视图、user_version 和 application_id；64 位整数与 BLOB 保留。不得仅导出已知业务表。原始 WAL 应随原备份保存；规范化包中的数据库须通过 SQLite 一致快照导出，在副本上转为 DELETE journal mode，再生成审计。不能删除正在使用的 WAL 来凑出“离线快照”。

## 清单生成入口

Windows 完成核验、最终停服备份和目录规范化后，将来源回执另存到私有 JSON 文件。回执只有 `source` 和 `target` 两部分：source 包含 platform（win32）、codeCommit（实际旧发布）、snapshotSha256（原始最终备份）、ledgerSecretKeySha256（原始 secret_key 的哈希）、createdAt、stopped.receiver/tunnel/ledger；target 包含目标 Mac sourceCommit 和本批 cutoverId。所有值来自实际核验，不能把 Git 最新提交代替正在运行的旧 release。

```text
node scripts/build-migration-package.mjs <规范化包目录> <私有来源回执JSON>
```

该入口只生成清单，不停机、不读取猜测的 Windows 目录、不修改 ACL 或搬运原件。必须在 Windows 本机先核验包目录/回执的 owner-only ACL。它拒绝把包放进源码仓库，拒绝覆盖已有 manifest.json，逐文件生成哈希、两库审计和配置语义核验后才写清单。生产模式要求在 Windows 执行；Mac 上仅可用 `--synthetic` 验证合成包。

合成演练和 Windows 真实导出均已执行，Mac/Docker 导入器独立复核全部内容；重复生成会拒绝覆盖。实际目录映射与停机证据单独保留，生成工具本身不能证明停机声明为真。

## Windows 到 Linux 的明确转换

- 配置路径转换到 `/var/lib/clawbot` 与 `/run/clawbot-*`，账本仍为 loopback 8888。保留原 secret_key，HTTP 与 MCP 使用两个不同的令牌。配置、来源及 Tunnel 规则均由离线检查校验。
- 微信账号索引、账号令牌、同步游标、上下文令牌及唯一 owner 的配对文件保留。若旧布局不同，先在 Windows 实际核验再映射；导入器不猜测账号名称。
- `openclaw-state/hooks/session-memory` 是平台相关可执行代码。原件留在 Windows 原始备份中；规范化包必须排除这一明确目录，由固定 Linux 镜像在首次启动时生成对应代码。导入器拒绝携带该目录，避免把 Windows handler 当成 Linux handler。此规则不允许删掉其他状态、回执或未知表。
- OAuth/系统凭据库是否可迁移，需要 Windows 侧核验；文件存在不代表授权有效。正式接收前必须在不启微信接收器的情况下验证官方模型授权，必要时在 Mac 本机重新登录。本次实际官方调用及历史读取通过；跨系统 SQLx 校验值与路径修复见 [兼容说明](codex-state-cross-platform.md)，不能由合成 OAuth 文件推断其他部署也可直接迁移。

## 导入与启动分离

完成来源核验和规范化后，本机使用 Node 22.23.1 或兼容的 Node SQLite 运行环境：

```text
node scripts/mac/import-migration.mjs production <私有包目录> <固定runtime镜像sha256> <原始最终备份sha256> <目标提交>
```

工具先在主机检查完整文件、语义和两库，再检查镜像、空间及目标资源。任何生产目标容器或同名目标卷已存在都会拒绝。只创建新的九卷；离线辅助容器再次检查、独占复制、校验文件权限和两库。失败的生产卷保留现场，不能重复导入覆盖。

全部校验通过后，九卷分别写入相同的只读 `.clawbot-import.json`，返回 `importManifestSha256`。创建生产宿主包时必须传入这个哈希，并与独立启用文件一致。生产预检逐卷核对凭证，缺失、混合批次或半完成导入均拒绝。导入成功本身不启动容器、微信或 Tunnel。

后续升级仍保留原导入凭证；其中首次导入提交是来源证据，不要求改成升级后的提交。新发布的代码/配置身份由宿主和镜像的独立检查负责。

初次部署在宿主尚未启用时运行 `node scripts/mac/provision-production.mjs <只读生产宿主目录>`。它先检查导入凭证、镜像、空间和资源不存在，再只创建三个停止状态的容器。重复/半成品项目拒绝，不借初次部署替换已有容器。之后才由独立启用流程允许常规宿主按 readiness 启动。共享驱动已在随机三服务环境实测“先创建但不启动、拒绝重复创建、按顺序首次恢复”；随后真实生产也已按此顺序创建停止容器并启用，见正式切换记录。

## 最后一步的启用回执

真实迁移时，顺序为：干净源码发布生产镜像 → Windows 最终包 → 导入返回清单哈希 → 同源码生成生产宿主包 → 只创建停止容器 → 最后核验后启用。宿主包准备命令为：

```text
node scripts/mac/prepare-production-host.mjs <生产镜像发布目录> <切换UUID> <原始最终备份sha256> <导入返回的清单sha256>
node scripts/mac/activate-production.mjs prepare <生产宿主目录>
node scripts/mac/activate-production.mjs enable <生产宿主目录> <私有核验回执JSON>
```

prepare 生成的核验回执默认所有项为 false，reviewedAt 为空。它不是 Windows 已停机的声明。enable 要求操作人员在 30 分钟内实际核验三项 Windows 停机、最终备份、官方模型授权、当前 owner/游标与唯一写入端切换；回执绑定源码、导入清单、最终快照、切换 ID 和两幅镜像。授权文件是否真的适用于新生产环境须单独验证，不能因 P1 已登录而直接勾选。

工具随后复核三个停止容器、输入、空间和精确 LaunchAgent。已有启用/维护/故障状态或生产任务均拒绝覆盖。启动后等待宿主与三服务就绪；失败撤掉本次启用门禁，并尽力停止已识别服务，保留数据和任务现场。不自动回退数据库。就绪成功仍须真实微信、账本和公网限制验收，不能仅凭健康检查宣布接管。

准备期只执行了共享驱动的首次启动实测及启用 CLI 的拒绝验证：一个绑定正确且新鲜、但确认项全 false 的合成回执被实际拒绝，前后生产容器、启用文件和生产任务均为空。真实 enable 正向流程随后在用户确认 Windows 停服并完成最终包后执行；准备期未制造停机声明。

## 已执行证据与边界

`scripts/mac/verify-migration-import.mjs` 已通过九卷实际导入、ledger 两表与 receipts 五表核对，包括未知表、索引、BLOB 和大于 JavaScript 安全整数的值；九份完成凭证一致。已有卷放入哨兵后，导入在写入前被拒绝，九卷逐项核验没有新增文件且哨兵原样保留。篡改附件也被拒绝。随机演练卷已清理，前后均无生产容器。

单元测试另外验证路径穿越、大小写别名、额外数据库路径、WAL、Windows 代码钩子、混合导入凭证和可写凭证被拒绝。真实 Windows 导出、认证布局核验和正式切换已有独立证据；反向迁移至 Windows 尚未在真实生产执行。
