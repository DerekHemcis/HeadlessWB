# HeadlessWB

[English](README.md) | **简体中文**

**WorkBuddy 5.11.3** Windows 桌面客户端的无头隐蔽版。

平时完全静默后台运行：无窗口、无托盘、无通知、无声，仅作为受控端被官方 WorkBuddy
手机 App 远程操控。唯一会看到东西的时刻是登录时弹出的一个浏览器标签页。

> **下载：** [Releases → v5.11.3](https://github.com/DerekHemcis/HeadlessWB/releases/tag/v5.11.3)
>
> **安装：** 下载 `HeadlessWB-Setup.exe`（约 392 MB），**双击即可**。

---

## 安装

1. 从 [最新 Release](https://github.com/DerekHemcis/HeadlessWB/releases/latest) 下载 **`HeadlessWB-Setup.exe`**
2. **双击运行**
3. 会依次看到：
   - 7-Zip 解压进度条（1–3 分钟，展开后约 1.3 GB）
   - 一个控制台窗口显示 5 个安装步骤
   - `安装完成` —— 按任意键关闭
4. 软件已在后台静默运行

| | |
|---|---|
| 安装位置 | `%USERPROFILE%\HeadlessWB` |
| 开机自启 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `HeadlessWB.exe --headless` |
| 需要管理员 | 不需要 |
| 服务 / 驱动 | 无 |

**首次安装**会自动打开浏览器到 WorkBuddy 登录页，扫码即可。
**已登录的机器重装**会直接静默启动，不用重新扫码（登录态在 `%USERPROFILE%\.workbuddy`，安装器不碰它）。

### 校验下载

```
文件    HeadlessWB-Setup.exe
大小    411,770,064 字节
SHA256  C051890969851862AF297C57FDA97C6E3F29C5C4BE456B1668B746F3C66AF3FF
```

```powershell
(Get-FileHash .\HeadlessWB-Setup.exe -Algorithm SHA256).Hash
```

---

## 特性

| 特性 | 实现方式 |
|---|---|
| **无窗口** | 压制 `BrowserWindow.prototype.show`；登录窗口以透明 + 屏幕外 + `skipTaskbar` 渲染后隐藏 |
| **无托盘** | `electron.Tray` 替换为哑对象，且容忍未知方法调用 |
| **无通知** | `electron.Notification` 哑化 **加上** session 层拒绝渲染进程通知权限 |
| **无声** | 全局 `--mute-audio` + 逐窗口 `setAudioMuted(true)` |
| **无弹框** | `dialog.showMessageBox*` 压制 |
| **不占「打开方式」** | 过滤 `reg.exe` 的办公文件关联写入 |
| **禁自动更新** | `/v2/update` 请求短路（含强制升级） |
| **无启动修复弹框** | 从产物中移除会弹「WorkBuddy 启动修复」的 `RepairApp.exe` |
| **按需唤起 GUI** | `wb-ctl.ps1 show` 还原并显示窗口 |
| **开机自启** | 单个 HKCU Run 键，纯 `--headless` |

---

## 常用命令

```powershell
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$D = "$env:USERPROFILE\HeadlessWB"

& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" status   # 状态（JSON）
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" show     # 临时显示界面
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" login    # 重新登录
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" stop     # 停止
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" start    # 静默启动
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\verify.ps1"          # 自检（JSON）
```

日志 —— 读取时务必加 `-Encoding UTF8`，否则中文在 GBK 控制台会乱码：

```powershell
Get-Content "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log" -Encoding UTF8 -Tail 50
```

---

## 运行模式

| 模式 | 行为 |
|---|---|
| 默认 / `--headless` | 无窗口、托盘、通知、任务栏闪烁。后台常驻，可被手机远控 |
| `--login` | 同上，并打开系统浏览器到登录页。已登录则整段流程跳过 |
| `--show` | 真实显示主窗口（调试）。关闭后进程仍存活 |
| `--status` | 写结构化状态到 `status.json` 后退出 |

`--status` 之所以写文件，是因为 Electron 在 Windows 上是 GUI 子系统程序，`console.log`
的输出在终端里看不到。

---

## 从源码构建

需要 **Node 18+** 与网络。在 macOS/Linux 上构建，产物面向 Windows。

```bash
node build.mjs                  # 下载官方包 → 打补丁 → 重打包 → 生成安装器
node build.mjs --force-download # 强制拉取官方最新版
node verify-build.mjs           # 六步验证
```

产物：

```
dist/HeadlessWB/            绿色版目录
dist/HeadlessWB.zip         绿色版压缩包（分卷在 release/parts/）
dist/HeadlessWB-Setup.exe   单文件安装器（7z SFX，分卷在 release/setup-parts/）
```

### 构建做了什么

1. 下载官方 `WorkBuddy-win32-x64-user` 安装包并校验 SHA-256
2. 解 NSIS 载荷 → `app-64.7z` → 应用目录
3. 向 `app.asar` 注入 `headless-patch.js` 后重打包，**完整保留每个文件的 `unpacked`
   标记与重复内容复用 offset 的语义**
4. **全量校验 12,232 个归档条目**：每个 payload 的 SHA-256 必须等于 header 记录的哈希，
   任一不符即中止构建
5. 关闭 `EnableEmbeddedAsarIntegrityValidation` fuse —— 重打包必然改变归档哈希，
   而 Electron 37 在 Windows 上同样会校验
6. `WorkBuddy.exe` → `HeadlessWB.exe`，打入 VC++ 运行库，移除 `RepairApp.exe`，
   同步更新 `install-manifest.json`
7. **断言 `dist/` 与源码逐字节一致**（SHA-256），并写出 `BUILD-INFO.json`
8. 打包成 7-Zip 自解压安装器

---

## 工作原理

补丁作为 `main/index.js` 的第一行加载，它：

- 在任何应用代码之前取得**真实的** `electron` 模块
- 安装 `Module.prototype.require` 垫片，使后续 `require('electron')` 拿到代理对象
  （`Tray` / `Notification` / `BrowserWindow` 已替换）
- **同时**改写真实对象的 `net.fetch`、`dialog.showMessageBox*`、`shell.openExternal`
  方法 —— 因为压缩后的应用有 22 处 `await import('electron')`，会绕过 require 垫片
- 过滤 `child_process`，让办公文件关联的 `reg.exe` 写入和 `RepairApp` 的 spawn 不会发生

登录流程：轮询等待登录卡片（`.login-view__button`）挂载，然后依次尝试类名选择器、
`closest()` 解析出的可点元素、合成指针事件，最后直接调用 React fiber 上的
`props.onClick`。如果机器已登录，preflight 会在任何点击发生前中止整段流程。

---

## 已知限制

1. **二进制未签名。** 首次运行 Windows SmartScreen 可能提示，需点「更多信息 → 仍要运行」。
   彻底消除需要购买代码签名证书。
2. **仅支持 Windows 10/11。** Win7/8 缺少打包的原生模块所需的 UCRT。
3. **不要移动或改名安装目录** —— 开机自启键指向绝对路径。
4. **安装路径要短**（≤255 字符）。产物内最长相对路径为 209 字符，而 Windows 默认仍执行
   260 字符限制。
5. **不能与原版 WorkBuddy 同时运行** —— 两者共用同一 userData 目录，因而共用 Electron
   单实例锁。
6. 登录自动化依赖 WorkBuddy 的 DOM 结构。若上游改版导致结构变化，补丁会退化为直接打开
   登录页，并把探测到的 DOM 信息写进日志。

---

## 卸载

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\HeadlessWB\uninstall.ps1"
Remove-Item "$env:USERPROFILE\HeadlessWB" -Recurse -Force
```

`%USERPROFILE%\.workbuddy` 里的登录态会被刻意保留 —— 删掉就要重新扫码。

---

## 目录结构

```
HeadlessWB/
├── build.mjs                     构建管线 + 安装器打包
├── verify-build.mjs              六步验证
├── patch/headless-patch.js       运行时补丁（本项目核心）
├── setup.ps1                     安装器入口（由 SFX 调用）
├── install.ps1 / uninstall.ps1
├── tools/{deploy,verify,wb-ctl}.ps1
├── assets/7z.sfx                 7-Zip SFX 模块（LGPL，取自官方包）
├── docs/
│   ├── install-guide.md          安装说明
│   ├── acceptance-checklist.md   验收清单
│   ├── razor-test-procedure.md   真机测试流程
│   └── specs/…-design.md         设计文档 + 全部真机实测发现
└── release/                      供 GitHub 下载的分卷（每卷 90 MB）
```

---

## 免责声明

本项目改造第三方桌面应用，用途是让它在**你拥有并控制的硬件**上无头运行，从而被你自己的
手机 App 远程驱动。

仓库本身不包含任何 WorkBuddy 代码 —— 构建时从腾讯 CDN 下载官方安装包。WorkBuddy 的商标与
版权归腾讯所有。请自行确认你的使用方式符合所在地区 WorkBuddy 的服务条款。

**不要**用它访问、监视或控制你不拥有、或没有明确授权控制的机器。
