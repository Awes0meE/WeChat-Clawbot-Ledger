# Windows 与 Mac 的远程协作

2026-09-09（新加坡时间）：**Mac → Windows 的 ZeroTier、专用密钥 SSH 登录和 SFTP 双向传输已实际通过。** Mac 核对了用户从 Windows 独立提供的 Ed25519 主机指纹，再固定 known_hosts 并使用严格主机校验。随后已完成 Windows 停服及 Mac 接管，Windows 现用于保管恢复副本，不能重新开启旧接收器。见 [正式切换记录](handoffs/2026-09-09-production-cutover.md)。

## 首次连接验收（2026-09-09）

- 前次 ICMP 连通但 TCP 22 超时；Windows 侧处理后，本次成功取得主机公钥，指纹与独立回执完全匹配。
- Mac 使用原专用 Ed25519 密钥，以 BatchMode 实际登录预定 Windows 用户，完成只读身份、PowerShell 版本和时间查询。
- 一个随机命名的合成文件经 SFTP 上传、下载后字节与 SHA-256 一致，远端文件和本机临时目录均已清理。
- 禁用公钥并只请求 password/keyboard-interactive 后，服务器返回 Permission denied (publickey)。这证明本次连接没有提供密码认证路径，不替代所有来源的防火墙测试。
- 本机连接别名为 `clawbot-windows`；实际地址、用户名、known_hosts、公私钥和本机配置均留在 Git 外。不转发 SSH agent。

当前已具备远程只读审核和私下传输能力。Windows 防火墙/ACL 的完整配置审核沿用 Windows 侧回执；离家后连接、Windows 重启后恢复及非授权来源拒绝仍需相应现场条件，未据本次成功登录提前宣称通过。


## 采用的方案

沿用已有 **ZeroTier 私网 + Windows 原生 OpenSSH Server + 这台 Mac 独有的 Ed25519 密钥**。ZeroTier 提供两机之间的私网连接；SSH 执行检查、运行现有 PowerShell 验收、传输备份。GitHub 保存代码和脱敏交接，不保存运行状态、地址清单或凭据。

这比开发期间反复人工搬运输出更适合后续联调，也能适应 Windows 离开家中局域网。无需家用路由器端口转发，不调整账本公网 Tunnel。ZeroTier 本身不提供远程命令执行；两台电脑仍须开机联网，Windows 睡眠时不能远程执行。企业或公共网络可能影响连通性，离家后须再验收一次。

若现有 ZeroTier 网络还有不受信任成员，创建专用于个人设备的私有网络；否则沿用原网络，固定分配两台设备的私网地址。不要开启默认路由覆盖、公共路由或整个家庭网段转发。仅授权明确识别的设备。

## 首次配置的顺序

1. 用户已完成两机 ZeroTier 组网。接续时先核验两端设备和地址；以下安装说明仅用于缺失或重建的情况：这台 Mac 安装官方签名的 ZeroTier，用户在可见界面批准系统要求的网络组件，加入已有 Network ID，并在 ZeroTier 管理界面授权这台设备。不要把 ZeroTier API token、设备 identity.secret 或登录信息发到聊天里。
2. Mac 在 Git 目录之外创建独立 SSH 密钥，例如 `~/.ssh/clawbot_windows_ed25519`；私钥只留本机，权限 600。交互设置口令，并通过 macOS 钥匙串/ssh-agent 使用。将 **公钥文件**交给 Windows；不复用其它服务器私钥，不转发 SSH agent。
3. Windows 的 ChatGPT/Codex 拉取本分支，先读取本页和 `WINDOWS-HANDOFF.md`。在管理员 PowerShell 中核验 Windows 版本、当前 SSH 服务、已有规则和账本任务运行身份；已有 SSH 配置时先读后合并，不能用模板覆盖。
4. 未安装时添加 Windows 可选功能 `OpenSSH.Server~~~~0.0.1.0`。先配置密钥、用户限制和防火墙，再启动 sshd。安装可能自动创建通用 `OpenSSH-Server-In-TCP` 规则；新安装且未被其它业务使用时，将其限制为本机 ZeroTier 地址与这台 Mac 的精确 ZeroTier 地址。不要保留一条另外允许任意来源的 SSH 规则。
5. 用运行账本服务的现有本地 Windows 用户接入，先按该用户已有权限工作；首次安装系统功能和需要管理员的操作由本地管理员执行，不自动新建管理员账户。账号名不能猜；Entra 身份目前不支持此密钥登录路径。
6. 在现有 `sshd_config` 的正确作用域中设置：只接受公钥、仅允许选定用户、关闭 TCP 转发及 agent 转发。配置变更先执行 `sshd.exe -t`，再启动或重启 sshd。配置已存在时注意 `Match` 作用域及 OpenSSH 首个值生效规则；不要简单追加到文件末尾。

示意配置中的占位符必须由 Windows 实测替换，不能原样执行：

```text
PubkeyAuthentication yes
PasswordAuthentication no
AuthenticationMethods publickey
AllowUsers <已核验的小写本地用户名>
AllowTcpForwarding no
AllowAgentForwarding no
```

Windows OpenSSH 的默认管理员密钥文件是 `%ProgramData%\ssh\administrators_authorized_keys`，普通用户默认使用 `%USERPROFILE%\.ssh\authorized_keys`。管理员文件必须只有 SYSTEM 和 Administrators 的合适权限；核验 ACL 后再导入单行公钥，避免覆盖已有公钥。以实际 `sshd_config` 为准。

防火墙规则应同时限制：TCP 22、Windows 的精确 ZeroTier 本地地址、这台 Mac 的精确 ZeroTier 来源地址，必要时也绑定实际 ZeroTier 网卡。网络类别可能显示 Public；可以使用 Profile Any 配合精确地址/网卡限制，不能仅为 SSH 关闭防火墙或把整张网络设为可信。

7. Windows 本地读取 SSH 主机公钥的 SHA256 指纹；Mac 首次连接时由用户核对指纹并保存。后续连接必须启用 `StrictHostKeyChecking yes`，不能自动接受变更、关闭主机校验或仅用 `ssh-keyscan` 输出证明主机身份。
8. 设置 sshd 为自动启动并验证重启后的状态。优先用 Mac 发起只读连接检查，再读取仓库版本及服务状态；任何输出均不包含环境变量全集、令牌、聊天记录、账户文件或数据库正文。

Mac 的专用 SSH 配置示意（在本机保存，不提交实际地址/用户名）：

```text
Host clawbot-windows
  HostName <Windows-ZeroTier-IPv4>
  User <Windows-local-user>
  IdentityFile ~/.ssh/clawbot_windows_ed25519
  IdentitiesOnly yes
  ForwardAgent no
  StrictHostKeyChecking yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ConnectTimeout 10
```

## 接通后的验收与迁移边界

- 从这台 Mac 的指定私网地址成功登录；密码登录及非授权来源被拒绝。
- 断线重连和 Windows 离开家庭网络后再次连接成功；保持主机指纹校验。
- 只读核验旧服务身份和版本，保留 Windows 全套测试。Mac 的 portable 子集不代替 Windows 运维回归。
- SSH 接通不触发停服。先完成 Mac 守护、备份恢复、隔离验收，再进入迁移窗口。
- 切换时先暂停 Windows 接收与网页写入，等待在途请求结束，制作完整一致快照并经 SSH/SFTP 私下传输；目标校验完成后启动 Mac。禁止两个接收端和两份公网可写账本并行。
- SSH 不适合承担必须手动授权的 ChatGPT OAuth 或微信登录；继续使用用户可见的本机界面。
- 切换完成后保留明确的回滚条件。Mac 已产生新交易后，不能直接重启旧 Windows 数据副本。

## 官方依据

- [ZeroTier 远程桌面与 SSH](https://docs.zerotier.com/remotedesktop/)
- [ZeroTier macOS 安装](https://docs.zerotier.com/macos/)
- [Microsoft：Windows OpenSSH 服务配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)
- [Microsoft：Windows OpenSSH 密钥及 ACL](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)

## 正式迁移进度（2026-09-09）

用户在旁确认后，Windows 已停服、禁用四项生产／测试任务并制作最终快照；Mac 已导入并接管。现有 SSH 通道已用于备份传输和 Windows 侧回归，公网账本由 Mac Tunnel 发布，不依赖 Windows 或 ZeroTier 在线。

准备期 `operations/migration-progress.json` 是人工进度记录，不是实时健康证据。当前 18990 页面由独立生产看板提供，按实际宿主与服务状态展示，入口见 [生产看板](mac-production-dashboard.md)。
