# HeadlessWB 项目方案（WorkBuddy 无头隐蔽版 · Windows）

日期：2026-11-22
状态：待确认（brainstorming 产出，未开工）

## 一、这是什么 / 为什么

在 WorkBuddy 官方 Windows 客户端（v5.11.3.43806934）基础上，做一个"无头隐蔽版"：

- **用途**：用户用官方 WorkBuddy 手机 App 远程操控自己的 Windows 电脑（Razer Blade 14）。电脑端作为受控 agent 常驻后台，不开任何图形界面。
- **为什么不用原版**：原版是给人坐在电脑前用的桌面应用，有窗口、托盘、通知，全部与"机器平时无人使用、只被手机远程驱动"的场景冲突。

**反目标（宁可不做也不要）**：任何可见的桌面痕迹（托盘/通知/任务栏窗口弹窗）；运行时需要管理员权限；被官方自动更新覆盖补丁后回退成可见原版。

## 二、事实基础（本次逆向勘察结论）

以下全部为实测，非猜测：

1. **安装包**：NSIS 自解压。下载直链 `https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.11.3.43806934-ecace0f7.exe`（459 MB，sha256 `2fd40059…b56b` 与官方 /v2/update 返回一致）。更新源接口 `GET https://copilot.tencent.com/v2/update?platform=workbuddy-win32-x64-user`。
2. **应用结构**：标准 Electron。安装器内 `$PLUGINSDIR/app-64.7z` → 解出应用目录，核心是 `resources/app.asar`（165 MB）+ `app.asar.unpacked`。asar 内 `/main/` 有 326 个主进程模块，`main-bootstrap.js` 是巨型打包产物（全部窗口/托盘/更新逻辑都在里面，含 `WindowManager`、`TrayController`、`SystemNotificationController`、`AutoLaunchController`）。
3. **窗口行为**：主窗口由 `ensureMainWindowStep()` 启动管线步骤无条件创建；`InitialRevealGate` 在 ready-to-show 后强制 `show()`。关窗默认走托盘（`closeToTray`），托盘不活跃时进程才退出。
4. **托盘**：`TrayController` 用 `new electron.Tray(...)` 创建，tooltip "WorkBuddy"，带未读角标。
5. **通知**：三层——`SystemNotificationController`（系统级 Electron Notification）、`imTipSound`（提示音）、`WindowsTaskbarAttention`（任务栏闪烁）。全部在 WindowManager 体内。
6. **自动更新**：`createDesktopUpdateService` 启动后 **30 秒做首次检查 + 每小时轮询**（`setInterval(…, 36e5)`），另有 startup force auto-update 与 forceUpgrade（强制升级）通道。下载后走 NSIS 静默安装（`/S --updated /D=...`），安装器有 Authenticode 校验（Tencent 签名）。**补丁版必须禁用全部更新路径，否则补丁直接被官方覆盖**。
7. **开机自启**：原版自带 `setLoginItemSettings`（写 HKCU Run 键，名字如 "WorkBuddy"），且启动时 `reconcileAutoLaunchStep` 会自我修复。改造后我们要**复用这套机制**写自己的 Run 键，同时让 reconcile 不把它清掉。
8. **登录**（已实测确认）：登录页**不在软件内部**。点击登录后，渲染进程调 `openWebWithLogin` → 主进程 `shell.openExternal` 打开**系统浏览器**到 `https://www.workbuddy.cn/console/client-login?code=<设备码>&target=/`。设备码由 daemon 的 `request-device-auth-code` 通道签发，浏览器登录成功后 daemon 侧收到授权回调，登录态持久化在 userData 目录。**这意味着我们根本不需要为登录显示任何窗口**——只要 daemon 在跑 + 能拿设备码 + 用系统浏览器打开该 URL 即可。
9. **远控通道**：手机 App 与桌面端同账号，走腾讯中转（daemon 与服务器长连接）。**这部分完全不动**，是改造版的命根子。
10. 主进程是**混淆+打包过的 JS**（模块被内联进少量大文件），直接改源码级逻辑成本高，但关键行为点（窗口 show、Tray 构造、Notification 构造、更新 URL/间隔）都有明确的字符串/API 锚点可打运行时补丁。

## 三、目标行为定义

### 状态机

- **HEADLESS（常态）**：无窗口、无托盘、无通知、无声、无任务栏条目。daemon 正常运行、可被手机远控、正常执行任务、正常读写 ~/.workbuddy 记忆。
- **LOGIN（首次安装，或登录态失效时）**：daemon 在后台跑着 → 向 daemon 申请设备码 → 用系统浏览器打开 `https://www.workbuddy.cn/console/client-login?code=…`（腾讯官方登录页，扫码）。登录成功后无需任何窗口操作，直接回到 HEADLESS。这是**唯一**会"看到东西"的时刻，且只有浏览器标签页。
- **SHOW（手动）**：终端 `HeadlessWB.exe --show` 才唤起完整 GUI（调试/看日志用），关闭窗口即回 HEADLESS（不退出进程）。

### 权限模型

- 默认完全权限（文件、shell、系统操作自动放行，不弹桌面确认）。
- 高危操作（初步定义：删除目录树、修改系统设置/注册表、安装/卸载软件、格式化）→ 通过官方手机通道在**手机端**弹二次确认。实现方式待验证：WorkBuddy 本身的任务确认流走 daemon→手机推送，桌面端只需确保永不走本地 `dialog`/通知确认（拦截 `dialog.showMessageBox`、Electron Notification，把确认请求转发给已有 daemon 通道）。具体哪类操作会触发手机确认由 WorkBuddy 引擎自己的规则决定，我们只在壳层保证"桌面永不弹"。

### 隐蔽性验收标准

1. 开机进入桌面后，任务栏、托盘、桌面无任何 WorkBuddy 痕迹。
2. Windows 通知中心无 WorkBuddy 通知。
3. 手机发任务 → 电脑执行 → 手机收到结果，全程电脑无任何可见反馈。
4. `tasklist` 可见进程（不追求进程级隐身，这是自己机器上的常驻工具，不是恶意软件；但进程名改中性名）。

## 四、技术方案

### 4.1 总体路线：Runtime patch + 外壳包装，不重打安装包

放弃"重打 NSIS 安装器"路线（签名丢失、体积大、升级困难），改为：

**A. 目录级改造**（一次性脚本 `build.mjs` 完成）：
1. 官方安装包 → 解出 `app-64.7z` → 得到干净应用目录（本仓库 `vendor/`）。
2. 向 `resources/` 注入一个 **patch 模块** `headless-patch.js`（普通未混淆 JS）。
3. 修改 asar 的 `main/index.js` 入口最前面加一行 `require('../headless-patch.js')`——用 `@electron/asar` 解包→改→重打包，或者直接 patch asar 的字符串表（入口文件很小，直接二进制替换等长字符串，避免整包重打包 165MB）。
4. 产出 `HeadlessWB/` 目录（绿色版，免安装）+ 一个 `install.ps1`。

**B. headless-patch.js 做的事**（全部在 app ready 前注入；实现上用的是 **Module.prototype.require 垫片**：补丁先取真实 electron，再把后续业务代码 `require('electron')` 换成代理对象——因为直接 `defineProperty` 覆盖 electron 导出在现代 Electron 上会因描述符不可配置而失败）：

| # | 补丁点 | 手段 |
|---|--------|------|
| 1 | CLI 参数解析 | 读 `process.argv`：`--headless`（默认）、`--show`、`--login` |
| 2 | 主窗口不显示 | 拦截 `BrowserWindow.prototype.show/showAndFocus/setBadge/flashFrame` → no-op（仅当 headless 模式且窗口非用户主动 `--show` 打开）。更稳的一层：拦截 `InitialRevealGate` 调用的 `revealMainWindowOnStartup` 里的 `e.show()`——直接 no-op 掉 `BrowserWindow.prototype.show`，`--show` 命令则通过新建窗口绕过（`show` 由我们自己的包装函数调用 `showIfNeeded` 恢复一次） |
| 3 | 无托盘 | `electron.Tray = class { destroy(){} setToolTip(){} … }` 替换为哑对象 |
| 4 | 无系统通知 | `electron.Notification` 替换为 never-show 哑类；`app.setBadgeCount` no-op；`app.dock`/`flashFrame` no-op |
| 5 | 无提示音 | `imTipSound.play` 相关静音（拦截 `webContents` 音频或直接让 tip sound 分支 canPlay 返回 false——patch `canPlayTipSoundInRenderer` 不可行（在闭包里），改为全局把播放路径的 AudioContext/webAudio 静音；兜底：接受提示音残留为已知限制，因为无窗口渲染进程通常根本不加载） |
| 6 | 禁用自动更新 | 三处：a) `app.commandLine.appendSwitch` 之外，直接把 `setInterval(…36e5)` 的更新检查废掉——patch `createDesktopUpdateService` 的返回对象方法（`check`/`checkForceUpgrade`/`quitAndInstall` 全 no-op）。b) 屏蔽 feed 域名：session/webRequest 层把 `copilot.tencent.com/v2/update` 短路成 204。c) host 解析层兜底（改 hosts 太脏，不做；用 net.fetch 的 Request 拦截足够） |
| 7 | 开机自启（我们自己的） | `install.ps1` 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `HeadlessAgent = "C:\...\HeadlessWB\HeadlessWB.exe" --headless`（改名后的 exe + 默认参数）。同时 patch 掉原版 `reconcileAutoLaunchStep` 对 Run 键的读写（避免它清掉我们的或写入它自己的） |
| 8 | 哑窗口保活问题 | Windows 上 Electron 关闭最后窗口默认退 app；原版靠托盘保活。托盘被哑化后需在 `window-all-closed` 上保活：patch `app.on('window-all-closed')` 行为为不退出 |
| 9 | 危险操作确认走手机 | 拦截 `electron.dialog.showMessageBox/showMessageBoxSync` → 若在 headless 模式，返回"取消"或拒绝（具体取决于 WorkBuddy 确认流的 fallback；实测后决定拒绝还是自动放行低危）。目标效果是确认请求不落在桌面 |
| 10 | 登录跳浏览器 | `--login`（或首次安装自动执行）：复用 daemon 的 `request-device-auth-code` 拿到设备码，拼 `https://www.workbuddy.cn/console/client-login?code=…&target=/`，`shell.openExternal` 打开系统浏览器。窗口照常隐藏/不创建 |
| 11 | 进程名中性化 | 复制 `WorkBuddy.exe` → `HeadlessWB.exe`（Electron 改 exe 名即可，进程名/任务管理器显示名随之变化；不改图标资源避免数字签名问题——exe 签名本来就无校验，但保留原资源最稳妥） |

**C. 自启注册**：`install.ps1`（用户级，无需管理员）写 Run 键；`uninstall.ps1` 删除。不写服务、不写计划任务（Run 键最不显眼且用户级足够）。

### 4.2 登录流程（纯浏览器）

- 首次安装后：daemon 已常驻 → 自动执行一次 `--login`：向 daemon 申请设备码 → `shell.openExternal` 打开系统浏览器登录页。用户扫码 → daemon 收到授权 → 无需任何窗口，进入 HEADLESS。
- 登录态过期：手机端发现设备离线，用户在电脑上手动跑 `HeadlessWB.exe --login` 重新扫码。
- 不做"自动弹登录窗口"（那会破坏隐蔽性）；浏览器标签页是唯一可见物，且只在用户主动触发时出现。

### 4.3 GUI 唤起

```
HeadlessWB.exe --show     # 唤起完整窗口（正常 show，绕过 no-op 补丁）
HeadlessWB.exe --headless # 默认
HeadlessWB.exe --login    # 申请设备码并打开系统浏览器登录页
HeadlessWB.exe --status   # 打印 daemon/账号/进程状态到 stdout（终端工具）
```

`--show` 时若已有 headless 实例在跑，用 Electron 的 `second-instance` 机制把参数传给已运行实例（原版已有单实例锁 `app-instance.js`，patch 层复用）。

### 4.4 更新策略（用户已选：可手动更新）

- 自动更新：**彻底禁**（4.1-6）。
- 手动更新：`build.mjs update` 脚本——从官方 `/v2/update` 拉新版本 → 重新走 A 流程出新的 HeadlessWB 目录 → 用户跑 `install.ps1`。补丁与官方版本解耦（补丁点全是行为锚点，官方改版后 build 脚本的锚点校验会报错提示需要适配）。

## 五、交付物

```
HeadlessWB/
├── build.mjs            # 下载官方包→解包→打补丁→产出改造目录（含锚点自检）
├── patch/headless-patch.js   # 注入的运行时补丁模块（核心，~300-500 行）
├── patch/entry-mod.js   # 入口 require 插入（构建时生成）
├── install.ps1          # 注册 Run 键自启 + 首次启动
├── uninstall.ps1
├── tools/wb-ctl.ps1     # 终端辅助：status/show/login/stop
└── vendor/              # 解出的官方应用（.gitignore，构建产物）
```

构建在 macOS（本机 Mac mini）上完成，产物目录拷到 Razer Blade 14 部署；`build.mjs` 全 Node 标准库 + `@electron/asar` + 7z，跨平台可跑。

## 六、风险与已知限制

| 风险 | 说明 | 对策 |
|------|------|------|
| asar 完整性校验（已解决）| 见第九节第 8 条：Electron 37 在 Windows 上确实校验，build 已关 fuse | `verify-build.mjs` 第 5 步断言 |
| 官方更新覆盖补丁 | 已通过禁更新 + Run 键指向我们的目录规避；官方更新器被禁后不会再触碰该目录 | 手动更新流程 |
| 版本升级后锚点失效 | main-bootstrap 是混淆产物，改版后字符串锚点可能变 | build.mjs 里每个补丁点带断言，构建失败即提示人工适配 |
| 提示音残留 | imTipSound 在渲染进程内，主进程层可能拦不全 | 已知：无窗口时渲染不活跃，实际触发概率低；实测若仍响，再在 session 层静音 |
| forceUpgrade 强推 | 官方可强制旧版升级，禁用后若服务端强推可能拒绝服务 | 接受（用户自担）；或将来发现服务端校验版本时再适配 |
| 无窗口时 GPU/渲染开销 | 原版窗口隐藏但仍创建 BrowserWindow | patch 2 让窗口 show 被 no-op，窗口对象仍在但从不绘制；内存开销 ~200MB 级，可接受；后续可尝试跳过 ensureMainWindowStep（风险高，二期） |
| 杀软/Defender | 未签名 exe + Run 键自启，可能被启发式标记 | 自己机器加排除项；不改系统级隐藏（这不是恶意软件，不做对抗） |

## 七、非目标（本期不做）

- 进程级隐藏（rootkit 式），服务/驱动注册表持久化
- 替代官方通信通道、自建远控协议
- 多用户/多设备管理
- macOS / Linux 版

## 八、实现状态（2026-11-22）

1. ✅ 逆向勘察（登录/托盘/通知/更新/自启机制全部确认，见第二节）
2. ✅ `build.mjs` 构建管线：下载→解包→asar 注入补丁→重打包（保留 unpacked 语义）→exe 改名→组装，**已在 macOS 全链路跑通**，产出 `dist/HeadlessWB/`（1.4 GB）
3. ✅ `headless-patch.js` 运行时补丁（require 垫片 + 全部隐蔽点 + `--show/--login/--status`）
4. ✅ `install.ps1` / `uninstall.ps1` / `tools/wb-ctl.ps1` / 部署说明
5. ⏳ **待做（只能在雷蛇 Windows 上实测）**：
   - 部署 + 实测四项隐蔽（无窗口/托盘/通知/任务栏闪烁）
   - 实测 `--login` 自动开浏览器 + 扫码登录成功
   - 实测手机远控 + 开机自启
   - 看 `~/.workbuddy/logs/headlesswb/patch.log` 修正个别未命中点

## 九、代码级二次验证（2026-11-22，静态核对 + mock 冒烟测试）

在无法真机运行的前提下，对补丁与真实代码路径逐条核对，结论如下（均找到原版源码证据）：

1. **保活三重保险**（`index.js` `onWindowAllClosed`）：Windows 上原版逻辑是「托盘活跃则不退（return）」。托盘哑化后 `TrayController.initialize()` 仍先置 `trayActive=true` 再 `new Tray()`（拿到 DummyTray），因此 `isTrayActive` 为 true → 原版自己就不会退；叠加补丁的 `window-all-closed` 监听与 `app.quit` 抑制，三层都不会让进程在关窗后自杀。
2. **单实例 + `--show/--login` 转发**（`index.js` `acquireSingletonLock` / `handleSecondInstance`）：第二个进程拿不到锁会 `app.quit()+process.exit(0)` 退出（`process.exit` 未被补丁拦截，正确）；第一个进程收到 `second-instance`，原版只会 `showOrCreateMainWindow()`（对已隐藏窗口仅 `focus()`，不显示）。补丁先注册的 `second-instance` 监听置 `showRequested=true` 并直接 `realShow()`，故终端 `--show` 能真正唤起 GUI。已在冒烟测试中验证「second-instance --show 解禁窗口」。
3. **`app.exit()` 刻意不拦**：`index.js/main-bootstrap.js/shell-env-async.js` 中的 `app.exit(0|1)` 是单例失败退出、更新超时兜底等硬退出路径，拦截会造成僵尸进程。正常后台运行不会走到这些路径（更新已禁）。
4. **任务栏角标**（`BadgeController.updateWindows` → `setOverlayIcon`）与更新进度（`setProgressBar`）已一并 no-op；隐藏窗口本身无任务栏按钮，此为双保险。
5. **渲染进程 HTML5 通知**：在 `session.defaultSession.setPermissionRequestHandler` 拒绝 `notifications` 权限，堵住主进程 `Notification` 哑化之外的漏网路径。
6. **冒烟测试 19 项断言全过**（`test/run-tests.mjs`，mock electron）：headless 压制 12 项、show 解禁、login 加载、status 退出、second-instance 解禁、更新拦截 204、正常请求放行。
7. **动态 `import('electron')` 审计**（2026-11-22 增补）：minified 代码里有 22 处 `import(`electron`)`（index/main-bootstrap/shell-env-async/rpc-connection/cdp-profiler/menu-builder/dev-env-actions2/localstorage-migration），会绕过 `Module.prototype.require` 垫片。逐处核对：**没有任何一处动态 import 解构 Tray/Notification**（这两个隐蔽关键对象只走 require→代理→哑对象）；`BrowserWindow` 动态 import 创建的窗口仍受原型 `show` 压制。但 `net.fetch`（shell-env-async 反馈服务、rpc-connection 扩展 feed）与 `dialog.showMessageBox`（更新确认、自检）确实可经动态 import 直达真实对象——因此补丁已改为**直接改真实对象的 `net.fetch` / `dialog.showMessageBox*` / `shell.openExternal` 方法**，require 代理、动态 import、直接引用三条路径一次性全覆盖（测试已加 3 条断言证明真实对象被替换）。
8. **⚠️ 重大修正：asar 完整性校验在 Windows 上确实生效**（2026-11-22 真机实测推翻先前判断）
   先前依据 Electron 文档"`EnableEmbeddedAsarIntegrityValidation` 仅 macOS 生效"认为 Windows 不受影响，**这是错的**。
   真机启动即 FATAL：`electron\shell\common\asar\asar_util.cc:143] Integrity check failed for asar archive`。
   结论：Electron 37 的该 fuse 在 Windows 上同样校验 asar header 哈希；重新打包必然改变哈希 → 启动即崩，
   且发生在 Node 之前，`main/index.js` 的补丁注入根本没机会执行（`patch.log` 不生成即此因）。
   修复：`build.mjs` 新增 `disableAsarIntegrityFuse()`，直接改写 exe 中 fuse 区第 4 位 `'1'→'0'`，
   回读校验；`verify-build.mjs` 增加第 5 步断言该位为 `'0'` 且 `OnlyLoadAppFromAsar` 仍为 `'1'`。

9. **PowerShell 脚本必须带 UTF-8 BOM**（2026-11-22 真机实测）：仓库原为 UTF-8 无 BOM，
   在 zh-CN（代码页 936/GBK）的 Windows PowerShell 5.1 上按 ANSI 解码 → 中文注释/字符串变乱码 →
   `The string is missing the terminator` 解析失败，6 个脚本里 4 个直接无法执行。
   修复：仓库内 6 个 `.ps1` 全部改为 UTF-8 with BOM，且 `build.mjs` 复制时再做一次兜底补 BOM。

10. **zip 布局**：早期 zip 带顶层 `HeadlessWB\`，`Expand-Archive` 后多一层，与文档契约不符。
    已改为 zip 根即应用文件；`deploy.ps1` 同时兼容旧布局（自动上移）。

11. **`ELECTRON_RUN_AS_NODE` 环境变量**：若启动环境带此变量，Electron 会退化成纯 Node，
    表现为 `bad option: --login`。`install.ps1` / `wb-ctl.ps1` 已在启动前主动清除。

12. **重打包保真性核对**（2026-11-22 增补）：把原版 asar 与新产物的条目列表做全量 diff → 新增 0 个、缺失 112 个（61 个跨平台 sidecar 文件 + 51 个因此变空的目录）。逐个确认这些**在官方 Windows 安装包里本来就不存在**（例：`koffi/build/koffi/win32_arm64`、`wwapi-electron/prebuilds/darwin-*` 均不在 Windows 包内），因此不是我们丢文件，而是 Windows 版官方也未分发。`verify-build.mjs` 已加第 4 步：逐个断言 6 个关键 Windows 原生模块（koffi win32_x64 ×2、node-pty ×2、im-napi、turing_sdk）在解压产物中存在。

13. **与原版 WorkBuddy 共存的单实例冲突**（2026-11-22 增补）：无头版沿用原版 userData 目录（好处是已登录态直接复用、免重新扫码），但 Electron `requestSingleInstanceLock` 以 userData 为锁——**原版与无头版不能同时运行**，否则后启动者抢锁失败退出。原版自启 Run 键名是 `WorkBuddy.WorkBuddy`（`resolveWin32AppUserModelId`）。因此 `install.ps1` 现在会：停掉 `WorkBuddy`/`HeadlessWB` 进程 → 删除原版 `WorkBuddy`/`WorkBuddy.WorkBuddy` 两个 Run 键 → 再写 `HeadlessWB` Run 键；`verify.ps1` 同步检查旧键已清、原版进程未跑。
