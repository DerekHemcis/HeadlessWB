# HeadlessWB v5.11.3

基于 **WorkBuddy 5.11.3** 官方 Windows 客户端改造的无头隐蔽版。

平时无窗口、无托盘、无通知、无声，仅作为后台 agent 被手机官方 WorkBuddy App 远程操控；
只有登录时自动打开一次系统浏览器。

---

## 安装

下载 **`HeadlessWB-Setup.exe`**（约 392 MB），**双击运行**即可。

安装过程：
1. 7-Zip 解压进度条（约 1–3 分钟）
2. 控制台窗口显示 5 个安装步骤
3. 完成后按任意键关闭 —— 软件已在后台静默运行

安装位置：`%USERPROFILE%\HeadlessWB`
开机自启：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `HeadlessWB.exe --headless`
无需管理员权限，不写系统服务。

> **首次安装**会自动打开浏览器到 WorkBuddy 登录页，扫码即可。
> **已登录**的机器重装会直接静默启动，不用重新扫码（登录态在 `%USERPROFILE%\.workbuddy`）。

---

## 特性

| 特性 | 说明 |
|---|---|
| 无窗口 | 主窗口从不 `show()`；登录阶段用透明+离屏+不进任务栏渲染 |
| 无托盘 | `Tray` 对象哑化（含未知方法兜底） |
| 无通知 | `Notification` 哑化 + 渲染层通知权限拒绝 |
| 无声 | 全局 `--mute-audio` + 逐窗口静音 |
| 无弹框 | `dialog.*` 压制；移除会弹「启动修复」的 `RepairApp.exe` |
| 不占「打开方式」 | 拦截办公文件关联的 `reg.exe` 写入 |
| 禁自动更新 | 拦截 `/v2/update` 请求（含强制升级） |
| 终端唤起 GUI | `wb-ctl.ps1 show` |
| 开机自启 | HKCU Run 键，纯静默 `--headless` |

---

## 常用命令

```powershell
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$D = "$env:USERPROFILE\HeadlessWB"

& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" status   # 状态
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" show     # 临时显示界面
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" login    # 重新登录
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" stop     # 停止
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\verify.ps1"          # 自检（JSON）
```

日志：`%USERPROFILE%\.workbuddy\logs\headlesswb\patch.log`（读时加 `-Encoding UTF8`）

---

## 校验值

```
文件    HeadlessWB-Setup.exe
大小    411,770,064 字节
SHA256  C051890969851862AF297C57FDA97C6E3F29C5C4BE456B1668B746F3C66AF3FF
```

```powershell
(Get-FileHash .\HeadlessWB-Setup.exe -Algorithm SHA256).Hash
```

---

## 已知限制

- **未数字签名**：首次运行 Windows SmartScreen 可能提示，需点「更多信息 → 仍要运行」
- 仅支持 **Windows 10/11**（Win7/8 缺 UCRT）
- 安装目录**不要移动或改名**，否则开机自启失效
- 安装路径过长（>255 字符）会失败（Windows 260 限制，产物内最长相对路径 209 字符）
- 与原版 WorkBuddy **不能同时运行**（共用 userData 单实例锁）

---

## 卸载

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\HeadlessWB\uninstall.ps1"
Remove-Item "$env:USERPROFILE\HeadlessWB" -Recurse -Force
```

登录态在 `%USERPROFILE%\.workbuddy`，卸载脚本不会删（删了要重新扫码）。

---

## 技术说明

- 构建于 macOS：解官方 NSIS 安装包 → 提取 `app.asar` → 注入运行时补丁 → 重打包 → 关闭 asar 完整性 fuse → 打 7z SFX 安装器
- 补丁通过 `Module.prototype.require` 垫片替换 electron 导出（`Tray` / `Notification` / `BrowserWindow`），并直接改写真实对象的 `net.fetch` / `dialog.*` / `shell.openExternal`（覆盖动态 `import('electron')` 路径）
- 构建带**全量自校验**：asar 内每个文件的 payload SHA256 必须等于 header 记录的 hash（12232 个文件逐一核对），不一致拒绝出包

完整设计文档与技术细节见仓库 `docs/`。
