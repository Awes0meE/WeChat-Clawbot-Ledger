# 微信记账候选项目调研

更新：当前发布链路已改为 Windows OpenClaw + OpenAI GPT-5.6 Sol 官方 Codex harness + 定制安全插件 + ezBookkeeping，不再使用本地 Qwen；详见 `../WINDOWS-HANDOFF.md` 和 `../docs/bookkeeping-deployment-brief.md`。当前分类为 11/45，超市消费整笔归“超市购物”，结构化回执、对话确认和确定性汇总已上线。下文仅保留 2026-09-03 首轮历史调研，不作为当前部署指令。

核验日期：2026-09-03。仅检索公开仓库、下载并阅读关键源码，未安装插件、未运行候选服务、未更改 OpenClaw 权限。不是完整安全审计或兼容性验收。

## 首轮调研时的本机与推理关系（历史）

当前 OpenClaw 在 Mac 上以 LaunchAgent 常驻；微信渠道为腾讯官方 openclaw-weixin。模型为 openai/gpt-5.6-sol，通过已有 OpenAI OAuth 登录访问云端；agentRuntime 为 openclaw，Codex 插件禁用。没有调用本地 Qwen。

OpenClaw 管理消息、上下文、权限和工具执行；语言模型负责理解与生成。记账计算、数据库写入可以由普通程序完成。只有在消息进入语言模型之前分流，简单记账才可能做到零模型调用；模型调用本地脚本并不等于整个链路没有模型调用。

## 候选

### FinancialClaw

- 仓库：https://github.com/riclara/financialclaw
- 核验提交：872a52796ff446c075f00fe76a63434db5959a85
- main package.json 版本 2.0.0，声明 Node >=24；本机 Node v22.23.1 不满足其声明。
- src/index.ts 实际注册记账、查询、币种、收入等工具，账本使用 SQLite。说明文档声明渠道通用。
- 它主要提供模型可调用的结构化工具，没有在入口源码看到原始微信文本的零模型解析分流。
- 有单元/集成测试文件；本次未运行。与本机 OpenClaw 2026.8.2、腾讯微信渠道的端到端兼容性尚未验证。
- GitHub API 本次返回 1 star，最后推送 2026-04-21。不能因为功能表完整就把它视作成熟、经过广泛使用的产品。

### 微信 ClawBot 记账 Agent

- 仓库：https://github.com/dabifang/-ClawBot-OpenClaw-Agent
- 核验提交：708a4fcb3608beb058d1d46bc61c683cfd4c780e
- 实际入口是 Flask API 服务，含正则解析、SQLite 和 LLM fallback。
- 仓库树中未见 OpenClaw 原生插件清单或 iLink 渠道接入实现；不能把启动服务等同于微信已经接通。
- src/parser.py 只要提取出正数金额就返回 success；分类不明时填 OTHER。因此 FairPrice 53.27 会走规则成功而不是请求 LLM/用户确认，橙汁也未见匹配关键词。
- 金额匹配直接查找第一个数字，包含日期的输入存在误识别风险；例如“2026-09-03 午饭 10.28”可能把年份当成金额。这是源码推断，本次未运行测试。
- SQLite 表未见独立币种列；金额使用 REAL。不能直接满足 SGD 与准确金额处理要求。
- GitHub API 本次返回 0 stars，最后推送 2026-04-29；README 的 90% 命中率和性能数字未独立验证。

### personal-finance-cn

- 仓库：https://github.com/Allen091080/personal-finance-cn
- 核验提交：1d19cd342723ee4ef43daba513896d3ff860a5ea
- Skill + Python 脚本，默认账本为 ~/finance/ledger.csv。
- Skill 明确规定人民币；支持微信支付 CSV 导入，不代表微信机器人自动接收消费记录。
- 自然语言到脚本参数仍需 Agent 理解；脚本自身不联网不能保证上游模型处理也不联网。
- GitHub API 本次返回 2 stars，最后推送 2026-03-14。

### Actual Budget + 接入层

- 官方仓库：https://github.com/actualbudget/actual
- 官方 API：https://actualbudget.org/docs/api/
- 社区 MCP 候选：https://github.com/agigante80/actual-mcp-server
- 成熟的本地优先账本与预算应用；官方提供 @actual-app/api Node SDK，能够新增交易和查询预算。它不是可直接调用的 REST API。
- 社区已有模型调用工具的桥接项目，但这不等于存在已验证的腾讯 iLink 即装即用记账插件。本次仅阅读 MCP 说明，未审计/测试其实现。
- 更符合用户不重写完整记账软件、未来需要预算及报表的要求；需要部署账本并适配微信输入。

## 初步建议

优先考虑 Actual Budget 作为长期账本，接入层只负责微信输入格式、SGD、Asia/Singapore 时间、分类及确认。FinancialClaw 作为轻量备选，先验证运行时和功能质量。

两种方案均需独立验证：消息重试不重复记账；金额以分等准确方式处理；不明类别先确认；已提交的记账才回复成功；支持纠正/撤销；备份恢复。第一版只做单条记录和按需查询，不启用月度定时任务。

普通 Skill/MCP 工具通常由语言模型调用。若用户坚持简单记录零模型调用，应额外核验 OpenClaw 当前版本的入站分流扩展点；不能声称安装一个 Skill 就自动绕过模型。
