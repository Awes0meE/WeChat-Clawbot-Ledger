# 合盖息屏，服务器继续运行

本机专用插电服务器已经启用 `SleepDisabled=1`。系统不睡眠和显示器不息屏是两件事：本次检查发现插电 `displaysleep=0`，且 Parsec 的 `Parsec Hosting` assertion 正在阻止自动息屏。

2026-09-18 18:47 +08:00，执行 `pmset displaysleepnow` 后，macOS 电源日志记录显示器关闭，CoreGraphics `CGDisplayIsAsleep` 返回 true。期间三个业务服务保持 healthy，公网 `/healthz.json` 成功，18:48 又收到新的成功微信轮询。测试结束通过短暂 `caffeinate -u -t 1` 唤亮屏幕。没有重启业务、改动账目、改变微信绑定或调整现有系统睡眠设置。

## 本机自动化

可选脚本 [lid-display-sleep.sh](../scripts/mac/lid-display-sleep.sh) 每五秒检查上盖状态。首次发现上盖关闭，或从打开转为关闭时，调用系统的 `pmset displaysleepnow` 一次；上盖持续关闭时不会反复调用。状态无法识别时退出，不采取显示器操作。它不设置系统禁睡眠，使用前仍须独立配置和验证本机服务器的电源策略。

本机已安装独立用户 LaunchAgent `com.clawbot.lid-display-sleep`，运行 Git 外的脚本副本：

- `~/Library/Application Support/Clawbot/lid-display-sleep/lid-display-sleep.sh`
- `~/Library/LaunchAgents/com.clawbot.lid-display-sleep.plist`
- 事件与错误日志位于同一 `lid-display-sleep` 目录。

任务在登录后启动，并在异常退出后由 launchd 重启；不属于业务宿主，也不改变 runtime/guard/host/dashboard 版本。它不依赖工作区继续存在，未验收重启后的登录前执行。五秒为轮询间隔，不承诺繁忙系统中的严格触发时限。

保留 Parsec 进程及配置。远程输入可能重新唤亮显示器；此脚本不会在同一次合盖期间与远程输入争夺显示器。需要再次息屏时可执行 `pmset displaysleepnow`，或重新开合上盖。若要求远程桌面同时始终保持物理屏幕关闭，应另行验证虚拟显示方案。[Parsec 官方说明](https://support.parsec.app/hc/en-us/articles/32381691348116-Black-Screen-Showing-While-I-Hear-Sound-and-Can-See-Mouse)说明屏幕关闭可能影响桌面采集；没有把本次服务健康检查视作 Parsec 远程画面验收。

暂停本辅助任务可执行：

```sh
launchctl bootout "gui/$(id -u)/com.clawbot.lid-display-sleep"
```

重新加载：

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.clawbot.lid-display-sleep.plist"
```

永久卸载时先暂停，再只删除上述确切 plist 与独立 `lid-display-sleep` 目录；保留其他 LaunchAgent、业务状态和电源设置。撤销系统禁睡眠是另一项操作，见 [原合盖恢复记录](handoffs/2026-09-18-lid-sleep-recovery.md)。

## 验证边界与发热

用户报告此前合盖使用一天服务正常，这是用户使用反馈，不是本次采样覆盖的持续时间。自动合盖息屏安装完成，实际合盖触发仍待用户配合验收；手动显示器休眠与服务继续运行已通过。

检查时 Docker 虚拟机、WindowServer 和其他桌面进程也有 CPU 负载；`pmset -g therm` 没有记录温度/性能警告，但没有测得 CPU 或外壳温度。不能据此认定屏幕是全部热源，或声称息屏已经消除发热。

本次私有采样位于 Clawbot `acceptance/display-sleep-2026-09-18`。复核应同时观察上盖状态、实际显示器睡眠状态、系统禁睡眠设置、新鲜服务状态及微信轮询；设置值或“息屏命令已返回”本身都不是完整验收。
