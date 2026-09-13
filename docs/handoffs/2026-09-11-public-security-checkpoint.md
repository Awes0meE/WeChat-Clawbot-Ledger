# 公网安全改动交接：2026-09-11

本次代码提交为 `12879ae`（`fix(security): add public traffic rate-limit guard and verification`），本会话已有推送 `origin/main` 成功记录。此记录不能作为 Cloudflare 规则启用、服务升级或完整安全审计通过的证据。

## 已有改动

- `config/cloudflare-ledger-rules.example.json` 增加 `publicTrafficRateLimit.paidPlan`：仅匹配 `ledger.66ccff-labs.com`，按 `cf.colo.id` 与 `ip.src` 计数，每 60 秒 60 次，阻断 30 秒。这是候选配置，不代表当前套餐支持或线上已应用。
- `scripts/test-ledger-public.mjs` 增加 `--verify-public-traffic-rate-limit`；PowerShell 入口增加 `-VerifyPublicTrafficRateLimit`。探针尝试观察 HTTP 429。
- 公网运维手册和脚本契约测试增加对应说明与断言。此前实现阶段未运行测试，不能引用历史测试数作为本次通过数。

## 未完成与接手顺序

### 2026-09-12 线上核验补充

已通过用户登录的 Cloudflare 控制台核验：当前域名使用 Free 套餐；自定义规则占用 1/5，`Clawbot Ledger registration and TRACE block` 为活动状态；速率限制规则占用 1/1，`Clawbot Ledger login rate limit` 为活动状态，列表显示匹配 `/api/authorize.json`。本次没有修改这些既有规则，未重新验证登录限流触发行为。

DDoS 页面显示网络层与 SSL/TLS 防护均为活动状态，HTTP DDoS 防护始终启用，未创建自定义 DDoS 替代。公网账本首页本次返回 HTTP 200。这证明当前存在平台防护，不代表进行了攻击压测或保证所有攻击都被阻止。

新增全站限流尚未部署：当前唯一限流名额已被登录规则占用，不能直接应用 `publicTrafficRateLimit.paidPlan`。未购买套餐、覆盖登录保护、调整主域名或 www 路由，也未重启业务。后续需要用户选择升级套餐，或另行设计并验证源站限流；不得把现有自动 DDoS 防护描述为本次新增部署。

2026-09-11 的本地定向测试结果为 132 通过、3 失败；三个失败均发生在调用 Mac 不具备的 `powershell.exe` 时，Windows 专用检查仍待在对应环境运行。该结果不能记为全套通过。

1. 对本次配置及探针执行针对性测试，确认计数窗口、请求数量和返回来源能够验证目标规则。观察到 429 本身不能证明特定规则生效，也不能证明抗分布式攻击能力。
2. 经可见本地浏览器或终端完成 Cloudflare 授权，核对当前套餐、既有规则及支持的参数；只修改已识别且属于此账本的规则，保留其他域名路由。保存脱敏的规则回读与验收结果。
3. 若需要更新业务运行时，遵循 `docs/mac-release-updates.md` 的当前数据备份、不可变发布及维护切换流程。Git 推送不等于生产升级；单独修改边缘规则也不必然需要重启业务。

最后已记录的生产验收版本仍以 `2026-09-09-production-cutover.md` 为依据，本次收尾没有重新查询线上状态。Windows 旧实例保持退役，恢复资料保留。

## 防护结论边界

新增内容是按来源 IP 限流的配置提案，不能宣称已经解决 DDoS。分布式请求可能分别低于限额；正常用户共享出口也可能共用计数额度。仍需记录实际边缘防护设置、源站暴露情况及正常访问验收，才能判断部署的防护效果。本次记录不代表所有代码、算法、依赖和部署行为均已完成安全审计。

`/neat` 是 `neat-freak` 文档整理技能入口，不是部署命令。本次整理仅修正文档中的完成状态与后续工作，不改业务数据或生产服务。
