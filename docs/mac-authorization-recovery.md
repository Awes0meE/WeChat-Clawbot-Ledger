# Mac 授权诊断与恢复

Mac 正式服务已经启用。当前版本见 [Mac 工作清单](mac-before-windows-checklist.md)；本页提供现有账户的诊断与维护入口。组件设计、错误注入及隔离演练保留在[历史验证记录](handoffs/2026-09-08-mac-authorization-development.md)。

迁移已验证官方模型实际调用、原微信身份接收、HTTP/MCP 只读访问和 Tunnel 公网访问。未在生产执行过的令牌轮换、微信重新扫码及 Tunnel 密钥替换，不因迁移成功而自动计为验收通过。

## 先做只读诊断

从仓库根目录执行，参数使用当前已安装的不可变生产宿主目录；源码 HEAD 不等于在线版本。

```sh
node scripts/mac/inspect-model-authorization.mjs '<生产宿主目录>'
node scripts/mac/inspect-ledger-authorization.mjs '<生产宿主目录>'
node scripts/mac/inspect-weixin-authorization.mjs '<生产宿主目录>'
node scripts/mac/inspect-tunnel-authorization.mjs '<生产宿主目录>'
```

入口前后核对宿主、镜像、容器及启动时间，不登录、不重启、不写账，不输出身份、令牌或原始错误。支持隔离检查的入口使用 `--test`；已退役测试实例无需为日常诊断重新启动。

| 结果 | 含义与处理 |
| --- | --- |
| 模型 `credentials-present` | 本地凭据存在，不证明云端调用成功或仍有额度 |
| 模型 `login-required`／明确重新授权告警 | 使用下方独立交互登录，不靠删除状态库恢复 |
| HTTP/MCP `accepted-read-only` | 账户列表、MCP 初始化和工具目录接受令牌；不证明写入、同账户身份或公网限制 |
| 微信 `last-poll-accepted` | 当前接收器有新鲜成功轮询；真实业务另验 |
| 微信 `reauthorization-required` | 上游明确返回 -14，按维护流程重新授权 |
| Tunnel `last-registration-accepted` | 自己的发布进程最近注册成功；另验连接和公网 |
| timeout／transport／unrecognized／stale | 检查、网络或证据不可用，不自动认定凭据撤销 |

模型诊断不追加 `--probe`：固定 OpenClaw 的模型探针会覆盖 agent harness，不能替代官方 Codex 实测。微信检查不启动第二个接收器；本地长轮询超时不算成功或授权撤销。Tunnel 运行凭据与网页登录管理证书用途不同。

## 更新前的共同准备

先确认精确宿主、账户和本次操作范围，保留原快照及恢复资料。需要修改正式授权时，停止已识别服务并备份当前九卷：

```sh
node scripts/mac/production-maintenance.mjs enter '<生产宿主>'
node scripts/mac/backup-production-state.mjs '<生产宿主>'
```

候选凭据、暂存回执、身份和审核 JSON 均放在 Git 外私有目录，不通过聊天或命令参数传递凭据。`prepare` 只生成默认未确认的审核文件；核对输入、身份、备份及授权范围后填写 `approved=true` 与 ISO 格式 `reviewedAt`，再使用对应 `apply`。首次审核通常 30 分钟有效，以脚本为准。

保存要求匹配的维护／启用记录、无存储故障、源卷无运行消费者、当前状态与备份一致。成功仍保持维护，不自动恢复收发。换账户、换 API 端点、换 Tunnel 或改路由不能套用同身份续期入口。

## 模型：独立交互登录与导入

```sh
node scripts/mac/model-authorization-stage.mjs prepare '<生产宿主>'
node scripts/mac/model-authorization-stage.mjs inspect '<生成的暂存回执>'
node scripts/mac/model-authorization-stage.mjs login '<同一暂存回执>'
node scripts/mac/model-authorization-stage.mjs verify-model '<同一暂存回执>'
node scripts/mac/import-model-authorization.mjs prepare '<生产宿主>' '<暂存回执>' '<当前九卷备份>'
node scripts/mac/import-model-authorization.mjs apply '<同一宿主>' '<同一暂存回执>' '<同一备份>' '<已核对审核文件>'
```

`login` 仅在用户可见的本机交互终端执行固定 OpenAI provider 的官方 device-code 登录。独立暂存卷禁用微信和工具，不挂生产数据或 Docker socket；无 TTY 时在发起 OAuth 前拒绝。`verify-model` 使用官方 harness、随机新会话和无工具合成请求，仅证明暂存授权可调用模型。

导入只通过固定官方接口保存匹配既有账户的一条授权，不支持首次创建 profile 或换账户，不整体覆盖 OpenClaw 目录。其他 profile、共享数据库、未知字段及业务状态必须保留；未知迁移、规范化丢字段或未处理 rollback journal 均拒绝。导入回执 `remoteVerified=false`，正式调用另验。

## 账本 HTTP／MCP 令牌更新

两种令牌必须独立。先通过原账本流程生成候选记录，再制作包含这些记录的当前备份；更新器不签发令牌。候选目录只含 `http-token`、`mcp-token`，目录 0700、文件 0600，由当前用户所有。独立核对用户名，私有身份文件格式为 `{"version":1,"expectedUsername":"已核对用户名","reviewed":true}`，不能从候选 JWT 自述推导预期身份。

```sh
node scripts/mac/rotate-ledger-tokens.mjs prepare '<生产宿主>' '<候选目录>' '<身份文件>' '<当前备份>'
node scripts/mac/rotate-ledger-tokens.mjs apply '<同一宿主>' '<同一候选>' '<同一身份>' '<同一备份>' '<已核对审核文件>'
node scripts/mac/check-saved-ledger-tokens.mjs '<同一宿主>' '<本次 saved 回执>'
```

保存前验证签名、同一启用用户、类型、有效期及撤销记录。两文件更新有持久中断标记，启动检查拒绝半完成状态。副本检查在无网络、无宿主端口的临时账本中进行，原数据只读；`serverAcceptanceVerified=true` 不代表正式服务已恢复。

中断后只在原输入、备份、started、审核及原／新令牌仍匹配时续接：

```sh
node scripts/mac/rotate-ledger-tokens.mjs resume '<原宿主>' '<原候选>' '<原身份>' '<原备份>' '<原审核文件>'
```

## 微信独立扫码暂存

先维护并完成当前备份，再执行：

```sh
node scripts/mac/weixin-authorization-stage.mjs prepare '<生产宿主>' '<当前备份>'
node scripts/mac/weixin-authorization-stage.mjs inspect '<同一宿主>' '<同一备份>' '<暂存回执>'
node scripts/mac/weixin-authorization-stage.mjs login '<同一宿主>' '<同一备份>' '<同一暂存回执>'
```

扫码仅在本机可见交互终端进行，候选保存在独立私有卷。不要对运行卷直接执行普通扫码保存：上游可能清理同一用户的其他账户并重载配置。同一用户但机器人账户或 API 地址改变时，保留候选并单独核对身份，不自动导入。

## 微信暂存导入的宿主维护入口

```sh
node scripts/mac/import-weixin-authorization.mjs prepare '<生产宿主>' '<当前备份>' '<暂存回执>'
node scripts/mac/import-weixin-authorization.mjs apply '<同一宿主>' '<同一备份>' '<同一暂存回执>' '<已核对审核文件>'
node scripts/mac/import-weixin-authorization.mjs resume '<原宿主>' '<原备份>' '<原暂存回执>' '<原审核文件>'
```

只更改既有账户的 token／savedAt，保留索引、配对、游标、上下文、其他账户、数据库及未知字段。外层其余八卷审核与内部 OpenClaw 全部状态审核须同时通过。续接需要原 started：状态仍等于原备份时可续写首次操作；已变化时只允许只读 `verify-saved` 后补回执。未知残留、游标变化或身份不符均保留现场。

## 同一 Tunnel 的维护凭据替换

候选是从原管理流程取得的同一 Tunnel 凭据 JSON，保存在 Git 外私有 `operations/` 下：

```sh
node scripts/mac/import-tunnel-credential.mjs prepare '<生产宿主>' '<当前备份>' '<候选凭据文件>'
node scripts/mac/import-tunnel-credential.mjs apply '<同一宿主>' '<同一备份>' '<同一候选>' '<已核对审核文件>'
node scripts/mac/import-tunnel-credential.mjs resume '<原宿主>' '<原备份>' '<原候选>' '<原审核文件>'
```

只替换原文件的 TunnelSecret，保留 TunnelID、AccountTag、未知字段及 0400 权限。不创建 Tunnel、不改 DNS 或路由；其他文件与两库须一致。已删除的 Tunnel、未知原文件或改路由不能作为普通续期处理。

## 恢复服务与清理

检查本次保存回执及完整状态保留结果，完成对应授权检查，再显式恢复：

```sh
node scripts/mac/production-maintenance.mjs resume '<实际选中的生产宿主>'
node scripts/mac/inspect-production-status.mjs '<同一宿主>'
```

模型、微信及公网分别验收。失败不自动恢复旧数据库，不删除去重、确认或游标；存储故障另走[对账流程](mac-storage-reconciliation.md)。只清理完成验证、不再用于导入且无消费者的本次暂存卷与临时文件；保留备份、密钥、原数据和验收记录。

## 生产状态汇总入口

`inspect-production-status.mjs '<生产宿主>'` 汇总四类诊断；[简洁生产状态页](mac-production-dashboard.md) 使用相同检查，详情默认折叠。执行前后绑定宿主进程、启用记录、运行批次、容器及启动时间，变化即丢弃旧结果；维护、故障或运行边界未知时不访问凭据。

本地凭据存在、微信最近轮询和 Tunnel 最近注册各有范围，不代替新做的云端推理、真实消息或公网验收。当前验收与未执行过的生产恢复操作分别记录在[正式切换记录](handoffs/2026-09-09-production-cutover.md)，组件证据保留在[开发归档](handoffs/2026-09-08-mac-authorization-development.md)。
