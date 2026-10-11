# 微信记账回归用例

合成文字消息统一保存在 [`wechat-bookkeeping.json`](wechat-bookkeeping.json)。当前 238 条覆盖日常支出、型号与数量、显式币种、消费时间、拟单与确认／取消、普通聊天、单条多问题、汇率查询、无效输入、转聊失效和消息重投。图片使用下述独立私有用例入口，不计入这 238 条。2026-10-11 的 [100 组图片场景集](image-semantic/README.md) 单独维护，包含公开图、合成边界图和两张私有故障原图。

200 条批量结果见 [2026-09-13 实测报告](results/2026-09-13.md)，口述小数修复的 16 条定向复验见 [补充报告](results/2026-09-13-spoken-decimal.md)。用户随后确认恢复可用，不等于全部 210 条完成手机端验收。

2026-10-04 新增 WX-211–WX-238，覆盖减乘除、运算顺序、斜杠确认／取消、备注分隔符、除零和精度边界。用户本轮明确要求加入减法，因此 WX-194“午饭10-2”的现行预期从不写入改为写入 8 SGD；其 2026-09-13 历史结果保持原样。本次状态见 [四则运算修复记录](../docs/handoffs/2026-10-04-arithmetic.md)。

这是长期积累的输入和期望，不是通过记录。运行结果另存；不能因为实现失败而把期望改成当前错误行为。

## 如何追加

每次发现新的表达方式或错误，在 `cases` 末尾新增一个永久编号，保留旧编号和历史用例。消息使用合成内容，不粘贴带真实身份、交易标识、凭据或私人会话的日志。必要时同时补最小的单元回归。

| 字段 | 含义 |
| --- | --- |
| `id` | 永久编号，例如 `WX-191`；不重复、不重新编号 |
| `group` | 便于按场景整理 |
| `message` | 要发送的原文，保留标点、空格、换行 |
| `conversation` | 可选；相同值表示按文件顺序连续对话，例如拟单后回复“是” |
| `replayMessageIdFrom` | 可选；重用同批次前一条消息的上游 ID，验证重投不重复入账；原文和会话必须相同 |
| `expected.action` | `record` 入账一次；`prepare` 拟单但不写；`cancel` 取消拟单；`query` 只读查询；`no_write` 不得写入 |
| `expected.amount` / `currency` | 应入账或拟单的原币金额及 ISO 币种 |
| `expected.amountOneOf` | 确实有多个合理候选时，限定候选金额范围，仍须用户确认 |
| `expected.category` / `commentEquals` | 可选的一级、二级分类数组和完整备注核对 |
| `expected.localDate` / `localTime` | 明确日期与钟点的精确核对，格式为 YYYY-MM-DD / HH:mm |
| `expected.dayOffset` | 相对本条可信发送日期的天数；昨天为 `-1` |
| `expected.replyContains` | 回复必须同时包含的答案要素，避免只回答多个问题中的一个 |

图片的 `reject` 要求零新增、没有待确认候选，并逐项审核追问或拒绝理由；`no_write` 不强制闲聊措辞一致；明确查询、拟单、取消和写入还需验证当前消息的持久化回执；已处理的同 ID 重投允许静默。测试逐条比较真实隔离账本新增记录、原币账户、金额和消费日期，不把模型说“已记账”当作写入证据。

日期示例的基准为 2026-09-13；以后修改具体日期时保留用例意图，避免变成未来消费。相对日期按执行时的 Asia/Singapore 计算。

## 实际模型测试

Mac Apple Silicon 的隔离验收入口：

```sh
node test-cases/validate.mjs
docker build --platform linux/arm64 --target isolated-test -f deploy/docker/Dockerfile.openclaw -t clawbot-message-acceptance:corpus-fixes .
export CLAWBOT_CORPUS_IMAGE=clawbot-message-acceptance:corpus-fixes
node scripts/mac/run-wechat-corpus.mjs run
node scripts/mac/run-wechat-corpus.mjs run WX-001 WX-002 WX-003
```

此入口针对本仓库已有的 Mac 运维环境，使用 `clawbot-test` 独立容器和卷、18888 账本、测试身份，微信接收器关闭。模型使用既有官方 Codex harness；正式模型凭据只在本机以只读方式复制到隔离状态，不打印、不提交。运行前需构建要验收的 `clawbot-message-acceptance:<tag>` 镜像，并通过 `CLAWBOT_CORPUS_IMAGE` 显式指定；示例 tag 是本次修复复验镜像。以后验收新源码必须重新构建并指定对应镜像，不能把旧镜像的结果算作新代码验收。

授权预检只接受隔离 Codex `auth.json` 或源端同名文件中足够覆盖该批次的有效授权；它目前不会读取生产 OpenClaw 持久化 OAuth profile。2026-09-13 授权修复后，旧源端 seed 已过期，重跑前须在隔离测试环境通过官方流程取得有效授权。遇到 `AUTH_TOO_SHORT_FOR_SUITE` 应先处理隔离授权，不修改生产 refresh token，也不把历史报告当作本次重跑结果。

完整链路为合成微信消息 → 正式 OpenClaw 分发与身份关联 → 实际模型 → 正式工具 → 真实隔离 ezBookkeeping → 正式回执发送钩子。最终发送被截获，因此不覆盖腾讯网络传输和手机微信实际收件。

选取确认流程时，必须同时选择该会话前面的拟单步骤。每次执行使用新的批次和消息 ID，保留隔离测试历史。结果 JSONL 保存在隔离回执卷的 `corpus/` 目录；模型原始日志在本机私有验收目录。只可将审查后的合成结果或汇总提交到仓库，不能提交原始模型状态或账本数据库。

2026-10-04 四则运算验收的最终 29/29 和初轮 15/17 结果见 [逐条报告](results/2026-10-04-arithmetic.md)。本轮隔离容器、七卷、网络、测试授权副本及两个中间镜像已按归属清理，保留最终测试镜像与验收记录；生产未改变。

2026-10-01 图片时间验收已导出证据，并核验清理隔离容器、卷、网络、测试凭据副本及临时测试镜像。下次运行会创建新的隔离环境；文字查询单项依赖既有测试数据，冷启动需先选择产生相应数据的用例。清理前导出必要结果，只删除归属本批次且已不用的资源，生产备份及恢复资料保留。

## 图片与时间的实际模型测试

把 `cases.json` 和图片放在 Git 外的私有目录，通过 `CLAWBOT_IMAGE_CASES_DIR` 指定绝对路径。该目录只读挂载为 `/image-cases`，替代默认文字用例；不要将真实订单、收货信息、账目或模型原始记录复制到仓库。先构建并指定本次源码的隔离镜像，例如：

```sh
docker build --platform linux/arm64 --target isolated-test -f deploy/docker/Dockerfile.openclaw -t clawbot-message-acceptance:image-time .
export CLAWBOT_CORPUS_IMAGE=clawbot-message-acceptance:image-time
export CLAWBOT_IMAGE_CASES_DIR=/operator/private/image-cases
node scripts/mac/run-wechat-corpus.mjs run IMG-001
```

用例文件结构示意如下；图片需另行准备，金额、币种与时间应和图中合成内容一致。默认文字校验器不读取这个私有文件，运行前需审核用例及期望。

```json
{
  "cases": [{
    "id": "IMG-001",
    "group": "image-payment-time",
    "message": "",
    "image": "/image-cases/paid-order.jpg",
    "expected": {
      "action": "record",
      "amount": "28.60",
      "currency": "CNY",
      "localDate": "2026-09-29",
      "localTime": "14:20",
      "localSecond": 35
    }
  }]
}
```

`image` 使用容器内路径；空 `message` 验证纯图片。`expected.localSecond` 为 0–59 的整数，直接核对新增账目秒数。测试编号确认时，先放 `expected.action: "prepare"` 的图片，再放相同 `conversation`、`confirmationOf: "前一图片用例编号"` 的后续用例；入口读取实际候选编号，默认生成确认语句，`decision: "cancel"` 则生成取消语句。确认后期望为 `record`，取消后期望为 `cancel`，并同时选择前置图片用例。

验收需分别覆盖付款优先、下单／创建时间、秒数、仅日期、仅物流时间、编号确认后保留原图时间，以及重复图片零新增。自动检查比较真实隔离账目和持久化权威回执；像素含义仍需人工核对，不能把结构一致当作通用识图准确率。

四张私有原图与候选流程见 [首版验收](../docs/handoffs/2026-10-01-image-bookkeeping.md)；日期测试首次 6/7 通过、修复后失败样本 1/1 通过，见 [时间验收](../docs/handoffs/2026-10-01-image-time.md)。这些结果不覆盖腾讯网络或手机收件，也不授权向生产重放测试图片。
