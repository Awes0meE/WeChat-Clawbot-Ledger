# Mac 最终候选恢复资料与未启用复验

2026-09-08。三小时观察签收后，从精确候选 `9f3c0e5295fe62185c7fc7863e1315745390839a` 的临时干净 detached worktree 执行最终归档与宿主复验，均通过。**生产仍未启用，Windows 继续接收。**

## 离线资料

14:38:56.373 UTC，`export-production-artifacts.mjs` 实际导出三幅 ARM64 镜像、对应源码 Git bundle、release/Compose 清单，重新加载后确认内容 ID 正确、没有镜像 tag 替换、容器清单不变。产物总计 507,520,362 字节，不含运行卷、授权或密钥。

```text
~/Library/Application Support/Clawbot/image-archives/
  9f3c0e5295fe62185c7fc7863e1315745390839a-5406b553-89f6-4415-9606-0e977deee6c6/
```

| 产物 | SHA-256 |
| --- | --- |
| `images.tar` | `8ad7d21f8fcf631a5cc8c071cab88a926c6b6c02fe8c691cdb99a641f18d518a` |
| `source.bundle` | `eaaf8d94723b8a6088b4418a717bb6d4be835b9898d36f574de637429f78f2c4` |
| `release.json` | `7b37cfb1352fcf2e96e9681b176c1ebb9224a20e45f977145e7690ca5638fe99` |
| `compose.production.json` | `8230fab641529eb66db0a2e8e9a89da5b33f30bafc35046a85f83fc35c5df20a` |

运行镜像完整 digest 与源码/业务验收范围见 [候选记录](2026-09-08-mac-dashboard-candidate.md)；归档内 `verified.json` 记录同一身份、上述文件哈希和实际检查时间。旧 `897f2ab`、`c04e79c`、`184c41d` 资料保留为历史恢复材料，不能写成最新候选。当前归档位于本机，异机副本和第二处密钥随 Windows 接入落实。

## 未启用宿主的实际 CLI 复验

同提交的 `verify-production-host-inactive.mjs` 真实调用宿主、状态汇总及启用入口，三项结果通过：

```text
CLAWBOT_PRODUCTION_HOST_INACTIVE_GATE_VERIFIED
CLAWBOT_DISABLED_PRODUCTION_OVERVIEW_VERIFIED_WITHOUT_ACTIVATION
CLAWBOT_UNCONFIRMED_ACTIVATION_REVIEW_REFUSED_WITHOUT_SIDE_EFFECTS
```

它证明缺少生产启用门禁时保持 disabled，状态汇总不声称外部授权已验收，未确认启用回执被拒绝。前后无生产容器、真实导入卷、生产任务或启用文件。此检查使用合成未启用宿主，不替代真实生产配置的正向启用。

临时宿主目录、启用审核回执和最终归档源码检出均已清理；没有删除授权暂存、在线测试卷或恢复资料。14:39 UTC 状态页再次 healthy、插电正常、授权检查无告警，三小时累计仍达标；[已固定观察证据](2026-09-08-mac-three-hour-observation.md) 保留完整原样采样。

P5 的 Mac 独立准备收尾通过。余下是文档全项签收与远端一致核验；真正 Windows 停机快照、生产导入、微信/公网和异机恢复仍按 [接续顺序](2026-09-08-windows-after-mac-preparation.md) 执行。
