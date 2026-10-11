# 100 张真实世界图片测试集

2026-10-11 按用户要求重建，当前主集 **100 张网上公开原图，0 张合成图**：80 张网页上的付款截图或小票照片，20 张 SROIE 真实扫描小票。图片不重画、不生成、不为测试补字。已知模板、占位演示、伪造图教程和同一交易的重复照片不纳入主集。

来源、原始文件 SHA-256、人工预期和判断理由见 [public-sources.json](public-sources.json)。原图保存在 Git 外，不随公共代码重新分发。网上公开不等于经过银行鉴真；这是识别与记账测试集，不是票据真伪数据集。

## 覆盖与判断

平台包括淘宝/天猫订单界面、京东、拼多多、Shopee、Lazada、Amazon、支付宝、微信、X、Facebook/Meta、YouTube、GCash、PayPal，以及 SeaBank、BCA、BRI 银行转账或 ATM 小票。另含新加坡、马来西亚、日本、韩国、美国和欧洲等地的真实购物、餐饮、燃油、五金和文具小票。

| 来源组 | 张数 |
| --- | ---: |
| 支付宝 / 微信 / 京东 / 拼多多 / 淘宝或天猫 | 4 / 4 / 3 / 4 / 2 |
| Shopee / Lazada / Amazon | 4 / 8 / 2 |
| Meta / YouTube / X | 2 / 8 / 3 |
| GCash / PayPal | 3 / 1 |
| SeaBank、BCA、BRI 银行转账和 ATM 凭证 | 4 |
| 其他网页上的真实小票照片 | 28 |
| SROIE 真实扫描小票 | 20 |

正例覆盖 13 种币种；银行样本目前集中于印尼，不能代表所有银行界面。

61 张预期直接入账，39 张预期零写入。拒绝样本保留缺日期、年份不全、金额裁切、退款、待付款、收入和多笔交易；不是只挑容易通过的图片。正例包含折痕、倾斜、手写标注、优惠、税费、现金找零、多种货币与日期格式，以及缺用途的成功付款。

- 单笔已发生支出，能确认实际金额与交易日期，即可入账。有商户、商品、服务或备注时保留相关详情；用途缺失或看不清时备注写“无”，不询问用途。
- 成功转出的银行或平台转账默认按支出处理，不要求额外证明收款人不是自己。收入、退款、明确本人账户间划转、未付款和预授权不新增支出。
- 缺日期或日期有歧义先询问；不能借网页发布日期、手机状态栏、订单编号或收图日期补齐。日期清楚但没有钟点，可披露采用收到图片时的钟点。
- 没有币种信息默认 SGD，包括没有其他线索的孤立 `$`；明确原币保留，明确冲突另行澄清。
- 一张图出现多笔不同交易时先指定目标；同一订单的多张界面不应误算成多笔。

预期由人工看图确定，不以模型输出生成答案。金额、币种、日期、时分秒、备注“无”、新增行数和当前消息权威回执均核对；零写入还需要人工检查其解释是否合理。100 张不是所有平台、语言或拍摄条件的穷尽，也不能当作总体准确率。

## 复现与查看

使用 Python 3 和现有 Mac ARM64 Docker 隔离验收环境。生成器已移除，组装器只下载原始字节并校验哈希。输出目录必须在 Git 外。

```sh
python3 test-cases/image-semantic/assemble.py /operator/private/image-real-100
# 打开该目录的 index.html，可筛选预期入账/不入账，点图看原图及来源。
docker build --platform linux/arm64 --target isolated-test \
  -f deploy/docker/Dockerfile.openclaw \
  -t clawbot-message-acceptance:image-real-20261011 .
export CLAWBOT_CORPUS_IMAGE=clawbot-message-acceptance:image-real-20261011
export CLAWBOT_IMAGE_CASES_DIR=/operator/private/image-real-100
node scripts/mac/run-wechat-corpus.mjs run
```

来源失效或哈希变化即停止，不能静默换图。模型使用官方 Codex harness；独占隔离测试状态，账本为 `18888`，微信发送被截获。不能把隔离测试当作手机、腾讯传输或生产发布验收。详见[运行说明](../README.md#图片与时间的实际模型测试)。

[上一轮报告](../results/2026-10-11-image-semantic.md)属于历史的 88 合成 + 10 公开 + 2 私有图测试，不能当作当前真实 100 张的结果。旧合成定义和生成器已从当前工作树移除，历史提交与报告保留可追溯性。上一版补录及历史测试见[旧发布记录](../../docs/handoffs/2026-10-11-image-semantic.md)。当前真实图片及缺用途规则已在 Mac `9d89ed2` 发布，见[本轮发布](../../docs/handoffs/2026-10-11-image-real.md)与[完整实测报告](../results/2026-10-11-image-real.md)。
