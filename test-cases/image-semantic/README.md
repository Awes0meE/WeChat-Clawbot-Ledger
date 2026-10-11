# 图片语义校验：100 组场景

2026-10-11 建立。Mac 已发布 `0f4114f`；[上线与补账记录](../../docs/handoffs/2026-10-11-image-semantic.md)单独记载生产操作。预期在模型执行前人工确定；发现失败保留原结果，修正后另记复验，不按模型输出修改答案。

## 样本组成与规则

- `SEM-01`–`SEM-88`：88 组可复现的合成图，定义在 [cases.json](cases.json)。覆盖中英德法日及地区写法、商户与商品用途、商品数量、原价/优惠/运费/税费/找零/余额、混合支付、不同消费场景、日期/秒/时区、缺字段、矛盾信息、未付款/退款/预授权、多笔交易、图内指令等。
- `PUB-01`–`PUB-10`：10 张通过网上图片检索选取的公开原图，包含倾斜、折痕、裁切、多小票、支付宝与电商截图。来源链接、检索日、SHA-256、人工预期及理由在 [public-sources.json](public-sources.json)。先选图再跑模型；缺日期等反例照样保留。不是随机抽样，也不能推导一般识图准确率。
- `CARD-1` / `CARD-2`：用户报告失败的两张私有原图。图片、金额、具体交易信息与完整参数留在 Git 外；公共仓库不打包这两图。

当前预期为 56 组直接入账、44 组追问/拒绝；用户提供候选后的拟单/确认/取消作为额外对话验证。

100 是独立图片场景数；额外确认与重复发送的对话轮次不凑入这 100 组。合成图用于控制变量，不能代替复杂自然照片。公开图可供个人本地验证，仓库仅记录链接及摘要，不重新分发原图。

判断基准：实际金额与币种、消费日期、商户/商品/服务/用途齐全，且是单笔已发生支出，即可直接记账。日期或用途缺失先追问，不能用网页发布日期、手机状态栏或收图日期补齐。只有日期而没有可用钟点，允许披露使用收图钟点。未付、退款、转账、收入和预授权不记新增支出。没有币种信息按用户指定默认 SGD（含没有其他线索的孤立 `$`），回执披露默认；有明确币种按原币，明确冲突或不能按 SGD 解释的符号才澄清。金额/币种有合理候选但仍不明确时拟单，确认前零写入。多笔图先拆分或指定目标。

## 复现

需 Python 3 + Pillow，以及已有 Mac ARM64 Docker 隔离验收环境和有效官方 Codex 测试授权。自定义字体可直接传给 `render.py` 的第二个参数；默认查找 Mac/Windows 中文字体。

```sh
# 输出目录必须在 Git 外；只生成合成图：
python3 test-cases/image-semantic/render.py /operator/private/image-suite

# 下载并校验公开图，合并 88 + 10 = 98 组：
python3 test-cases/image-semantic/assemble.py /operator/private/image-suite

# 操作者持有两张故障原图时，额外合并为 100 组。
# 私有目录的 cases.json 包含 CARD-1/CARD-2 定义和原图文件。
python3 test-cases/image-semantic/assemble.py /operator/private/image-suite \
  --originals-directory /operator/private/original-cases

docker build --platform linux/arm64 --target isolated-test \
  -f deploy/docker/Dockerfile.openclaw \
  -t clawbot-message-acceptance:image-semantic .
export CLAWBOT_CORPUS_IMAGE=clawbot-message-acceptance:image-semantic
export CLAWBOT_IMAGE_CASES_DIR=/operator/private/image-suite
node scripts/mac/run-wechat-corpus.mjs run
```

下载失败或来源哈希改变即停止，由操作者重新核对图片及预期；不能静默替换。完整入口与授权说明见 [测试说明](../README.md#图片与时间的实际模型测试)。运行独占隔离状态；不要并发启动两个模型 CLI。合成图字体、排版与来源图均应目视检查后再用于验收。

## 验收与报告

完整链路为图片 → 官方前置识图 → 记账模型 → 可信微信消息上下文 → 正式工具 → 18888 隔离账本 → 当前消息权威回执。微信发送被截获，不能把本测试当作手机或腾讯传输验收。

每组比较真实新增交易数量、原币金额、币种、日期、可读时分秒及回复；直接入账与拟单必须有当前消息权威回执。拒绝/追问必须零写入且无候选；歧义候选必须零写入、金额有依据。另人工审核回复理由和用途，不能把“不写”一律算对。

本轮执行记录在 [结果报告](../results/2026-10-11-image-semantic.md) 中逐组列出；原始日志、图片和账本保存在私有验收目录。历史失败、修复原因、复验、未执行边界分别记录。上述 100 组测试没有生产写入；后续用户明确授权的两笔原图补录见发布记录。

用户追加默认 SGD 规则后的补充合成图见 [followup-cases.json](followup-cases.json)，可用 `render.py OUTPUT_DIRECTORY --cases test-cases/image-semantic/followup-cases.json` 生成到单独目录；它们不计入主集的 100 组。另复验币种冲突确认/取消、补日期后重发与原图防重。
