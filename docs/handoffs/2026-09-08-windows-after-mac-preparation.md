# Windows 接续 Mac 迁移的执行顺序

2026-09-08，接续入口已核对。**Mac 独立准备已完成：三小时观察、9f3c0e5 最终离线归档与未启用宿主复验均通过；Windows 现在维持生产。** 见 [Mac 最终回执](2026-09-08-mac-preparation-complete.md)。 完成状态以 [Mac 当前清单](../mac-before-windows-checklist.md) 为准。本页准备后续执行顺序，不构成已停机、已导入或已启用的证据。

## 1. 同步代码并核对两端身份

Windows 先检查工作区、当前分支和远端；保留未提交工作，再 fetch 并安全切到/快进 `origin/feat/mac-docker-runtime`。不要 reset hard、覆盖本地修改或假定 main 已包含 Mac 开发。读取根 AGENTS.md、WINDOWS-HANDOFF.md、本页和当前清单；拉代码不部署服务。

Mac 待用生产源码为 `9f3c0e5295fe62185c7fc7863e1315745390839a`，在线测试宿主为 `6ab7c37`；三小时观察在原 `d53b535` 上完成。镜像完整 digest 和同源码业务结果见 [候选记录](2026-09-08-mac-dashboard-candidate.md)。运行镜像、源码 HEAD 和 Windows 当前不可变 release 必须分别核验。历史 Windows release `1ab154f...` 只是接续线索，不能未经现场检查就写成当前运行值。

用户已让两机加入同一 ZeroTier 子网。按 [远程接入步骤](../windows-mac-remote-access.md) 检查连通、合并已有 Windows SSH 设置、配置 Mac 专用公钥及精确来源防火墙。用户核对主机指纹后再信任；私钥、密码、授权链接、二维码和 token 不进聊天或 Git。SSH 连通只开始审核和联调，不停业务。

## 2. 停服前完成可执行准备

- 只读核验 Windows 实际进程、端口 owner、不可变 release、显式配置、定时任务/自动重启入口、旧 Tunnel connector、两库及附件、账号/授权/游标路径。只记录脱敏结论，原始路径和身份回执留私有目录。
- 在 Windows 隔离测试环境完成当前分支适用的完整回归。Mac 的 639 项通过明确排除了 11 个 Windows 操作文件；不以其代替 Windows 验证。不得把 Linux wrapper 或 isolated-test 配置发布到在线 Windows。
- 按 [迁移合同](../mac-migration-intake.md) 制定实际 Windows→Linux 文件映射，保留原 secret_key、两类独立 token、完整回执数据库、微信账号/配对/游标及未知状态。系统凭据若不能直接迁移，采用固定官方登录/存储入口；不推测文件复制等于授权可用。
- 核算真实数据、备份、导入和恢复空间。Mac 最近约 20 GiB 立即可用是测试时快照，不能保证装得下未知生产数据。遵守入口的至少 10 GiB 保留、双份估算及归档预算；不足时先解决容量，不改低门槛让检查通过。
- 确定私有传输目标、异机加密副本和第二处密钥保管位置，准备传输后哈希核验。先确认这些前提，再安排最终停机窗口。

## 3. Windows 最终停机和一致快照

先识别并记录旧任务的原配置和启用状态，关闭已识别的自动重启/登录启动入口，避免停止后被拉起或日后 Windows 开机重新接收。按已核验任务停止旧微信轮询器和旧公网 Tunnel，阻止新增写入，等待在途处理结束，再停止账本写入。不要停止未知进程或删除账号、旧状态和旧任务原件。

同时保存账本、附件、完整回执/确认/去重状态和授权/游标的一致最终快照；SQLite 必须包含已提交 WAL，不能只复制在线主 db。保留完整原始最终包及 SHA-256，在副本上做规范化。依据真实停机核验填写三项 stopped 声明，再从 Windows 执行：

```text
node scripts/build-migration-package.mjs <规范化包目录> <私有来源回执JSON>
```

回执和九卷内容按迁移合同生成。用已验证的 SSH/SFTP 私下传输并核对哈希；GitHub 只传代码和脱敏文档。Mac 的 synthetic 模式不能替代 Windows 的正式来源声明。

## 4. Mac 导入审核与最后启用

在候选 `9f3c0e5` 的干净源码检出中执行正式流程。真实值均由前序回执提供，不从文档示例生成生产身份：

```text
node scripts/mac/import-migration.mjs production <私有包目录> <固定runtime镜像sha256> <原始最终备份sha256> <目标提交>
node scripts/mac/prepare-production-host.mjs <生产镜像发布目录> <切换UUID> <原始最终备份sha256> <导入返回的清单sha256>
node scripts/mac/provision-production.mjs <只读生产宿主目录>
node scripts/mac/activate-production.mjs prepare <生产宿主目录>
```

导入只写新的九卷，完成全文件/两库全表审核；已有或半完成资源拒绝覆盖。首次 provision 只创建三个停止容器。最后现场复核 Windows 确实停服且不会自动拉起、最终包及当前目标一致、所有者和游标正确、授权可用、空间和任务身份合格。启用回执默认各项 false，只能按事实填写，且有近期时效要求；过期重新核验。

```text
node scripts/mac/activate-production.mjs enable <生产宿主目录> <私有核验回执JSON>
```

需要重新授权时按 [授权恢复](../mac-authorization-recovery.md) 的适用入口在用户可见的本机终端/浏览器完成；维护导入要求真实宿主和已验证备份，不能在条件未成立时套用。启用失败保留数据，入口尽力停止本次已识别服务；不自动恢复数据库或启动 Windows。

## 5. 正式验收与看板切换

先核验实际生产宿主和三服务身份、唯一接收器和唯一可写账本，再完成真实微信的明确记账、确认/取消、查询及去重/当前消息回复验收。真实平台重放仅在实际触发时记通过；测试模拟相同 ID 不能替代它。

按 [公网 runbook](../ledger-cloudflare-runbook.md) 验证 `ledger.66ccff-labs.com` 的原生登录、关闭注册/密码找回、有效 API/MCP token 公网拒绝和 origin 异常时关闭入口。有效凭据只在本机进程内使用。`66ccff-labs.com`、`www.66ccff-labs.com` 路由不改，不增加 Access 或暴露 origin。

正式服务健康后，按 [生产看板](../mac-production-dashboard.md) 从同源干净检出准备并切换状态页任务。该入口只切看板，不启用业务；可捕获失败回退旧看板，中断时按私有记录显式接续。遇到未知任务/端口或遗留操作锁先核验，不能自动抢锁。

三小时要求取代原 24–48 小时等待。Mac 独立观察达标不声称新生产版本已经长跑；正式环境记录自己的健康和恢复证据，持续后台监控，不凭旧测试容器 uptime 补齐。家庭网络中断后的真实 iLink 补收/游标及真实授权恢复须记录适用范围。

## 6. 备份、清理与回退边界

按 [维护与备份](../mac-maintenance-backup.md) 生成并验证正式九卷加密备份，将已验证复制包送到约定异机目标并再次核验/恢复，密钥另存用户控制的第二处私有位置。旧 Windows 服务保持禁用，原始最终快照和恢复材料保留。只清理已确认无用的演练资源；生产看板切换本身不会删除旧测试容器，后续应先确认测试实例归属和备份再退役。

Mac 尚无新写入时，仍须核对状态一致后才能计划恢复 Windows。Mac 已有交易、确认、去重或待发送状态变化时，先停 Mac 写入并取完整一致快照，核对新增状态、Windows 原生 MCP/旧运行时的兼容性和反向转换，再做有证据的回迁。不能直接启动旧 Windows 数据库并声称无损回滚。

最终记录实际启用版本、两端任务状态、完整数据核对、真实微信/公网结果、备份位置类别和人工恢复限制；只提交脱敏证据。未验证的项目明确保留，不用“服务 healthy”代替正式验收。
