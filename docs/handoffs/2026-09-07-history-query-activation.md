# 历史查询开通记录（2026-09-07）

用户在确认历史明细查询尚未启用后，明确要求开通。当前本地服务已开通，携带有效 MCP 令牌的公网连接拒绝检查及真实微信历史查询均已通过。

## 已完成

- `scripts/configure-ezbookkeeping-mcp.ps1 -WhatIf` 通过；核验正式 `8888` 的精确任务、进程身份和健康状态后执行交互式开通。
- 2026-09-07 00:02（`Asia/Singapore`）脚本报告成功。密码由用户在可见 PowerShell 中输入，独立 MCP 令牌保存在本机 owner-only 文件；开通时未向公网发送令牌，后续仅按下述明确授权进行连接检查。令牌未被输出或提交。
- 配置中的 `enable_mcp = true`，`mcp_allowed_remote_ips = 127.0.0.1`。生产与测试端口、OpenAI 模型、工具 allowlist 和 Cloudflare 路由均未调整；本次未写入交易记录。
- 本地 MCP 握手通过，工具目录包含 `query_transactions`。本次本机探针只读取工具目录，没有读取交易。
- 独立令牌 ACL 与无静态 MCP 凭据后备连接检查通过；MCP resolver 与 manifest 策略测试 7/7 通过。
- 匿名公网登录页返回 200 且匹配 ezBookkeeping；匿名 `/mcp` 返回 400，本机内存核验 JSON 为 `success=false`、`errorCode=200020`、`path=/mcp`，即 IP 限制拒绝。上述匿名检查没有向公网发送凭据。
- 2026-09-07 00:39，用户明确允许仅向 `https://ledger.66ccff-labs.com/mcp` 发送 MCP 令牌做一次连接检查。固定 HTTPS 目的地、禁止重定向的 `initialize` 请求返回 400，核验为同一明确 IP 拒绝 JSON，没有有效初始化结果。只发送了这一条请求；没有使用 API 令牌、调用交易查询或输出原始响应。
- 00:53，完成 `bookkeeper.tools.profile` 的修正并核验 Gateway 热加载成功，RPC 继续健康。现有六项精确 `allow` 未变化；除 CLI 维护的配置修改元数据外，其他配置与变更前备份一致。模板同步修正，提示词与 MCP 策略测试 16/16 通过。
- 00:55，真实微信回合的工具目录包含全部六项账本工具；该回合通过 Code Mode 调用 `ezbookkeeping__query_transactions`，本机审计记录 `tool.action.finished` 为 `succeeded` 且无错误码。用户确认微信正常返回历史明细。仅核验时间、工具名、状态与用户反馈，没有复制聊天或交易内容到仓库。

## 开通过程中的修复

1. 可见 Windows PowerShell 5.1 继承了 Codex 自带新版 PowerShell 的模块搜索路径，`Set-Acl` 自动加载失败。显式导入 `$PSHOME` 下的 `Microsoft.PowerShell.Security` 后通过。这是启动环境问题，与仓库迁移到 `F:\WeChat\_Clawbot\Clawbot` 无关；没有修改全局模块路径。临时诊断启动器自身的空值处理也曾报错，已修正后完成开通；它不是仓库脚本。
2. `Wait-LedgerListenerExit` 在第一次看到端口后，第二次核验 owner 时可能遇到服务已退出，错误触发回滚。新增独立的端口消失确认；仍有监听、身份变化或探测失败时继续拒绝。新回归先复现三项失败，修复后与 MCP 开通脚本相关检查合计 22/22 通过。测试使用合成对象，未访问正式账本。
3. 官方 Gateway 重启等待超时，之后确认 `18789` 无监听且没有 Gateway 进程，再通过原有 `gateway.cmd` 隐藏恢复。随后用 `openclaw gateway stop --force --json` 执行官方非交互停止，确认该临时实例完全退出后，于 00:31 从原有 `OpenClaw Gateway` 后台任务启动成功。RPC 健康、进程身份、回环绑定与微信通道 Running 检查通过，本地 MCP 连接再次通过。启动任务和启动器路径均未修改；本轮没有进行 Windows 登录或整机重启验收。首次重启超时的根因尚未确定。
4. 00:38 的新微信回合仍未加载历史查询工具。正式插件清单能解析出 MCP 服务，令牌和 owner 配置均正常；进一步用已安装 OpenClaw 的实际策略管线离线复现：`profile=minimal` 先过滤掉原生 MCP 工具，后续 `allow` 无法重新添加。五个普通账本工具在插件元数据中声明了 minimal profile，因此此前能够使用。将基础 profile 改为 `full`，继续用原有六项精确 `allow` 限制能力。19 项工具目录的离线对照验证只放行这六项，其他 13 项全部被过滤；没有执行这些工具或连接账本。模板回归先失败，修正后通过。

本节开通验收时，修复仍在 `fix/mcp-activation-restart`，在线仅应用单项代理配置修正，插件与 workspace 使用 `1d487943433869d0422f1bf4446fd046717c3647`。这些修复随后已提交并发布为 `c05813e16d5c87096dc379fc51c00fad648b0b94`；当前状态和记账交叉验收见 [系统检查记录](2026-09-07-bookkeeping-system-audit.md)。

## 验收范围与既有缺口

- 所有者真实历史查询已由实际工具成功记录和用户确认共同验收；没有仅凭本地工具发现宣告完成。
- 本次完成的是 MCP 连接拒绝专项检查，未重跑完整公网验收矩阵。开通当时的 `test-ledger-public.ps1` 要求 API 令牌，且对 MCP 只接受 401/403/404；匿名与带令牌的实际响应均为上述明确 IP 拒绝 JSON。当前检查器已在 c05813e release 加入 HTTP 400 且 success=false、errorCode=200020、path=/mcp 的严格判定，不能将任意 400 当作通过；完整矩阵仍按运维手册执行。
- 此前真实平台重复 message ID 的验收缺口仍然存在，本次历史查询开通不替代它。

账本配置备份由开通脚本保存在受限的正式配置目录。OpenClaw 工具策略变更前的完整备份为 `D:\Clawbot\backups\openclaw-before-history-tool-policy-20260907T005248.json`，已核验哈希一致与 owner-only 权限。出现问题时按原脚本和 runbook 恢复明确对应的配置与服务状态；不得恢复或覆盖账本数据库。
