# HeadlessWB —— WorkBuddy 无头隐蔽版（Windows）

> **最简单的安装方式：双击 `HeadlessWB-Setup.exe` 即可**（自动解压 → 安装到 `%USERPROFILE%\HeadlessWB` → 写开机自启 → 启动）。
> **下载：** https://github.com/DerekHemcis/HeadlessWB/releases/tag/v5.11.3
> 详见 `docs/install-guide.md`。

在官方 WorkBuddy Windows 客户端基础上改造的无头受控端：平时无窗口、无托盘、
无通知、无声，仅作为后台 agent 被手机官方 WorkBuddy App 远程操控；只有登录时
自动打开一次系统浏览器。

## 构建（在 macOS / Linux 上，产物拷到 Windows）

```bash
node build.mjs
# 可选: node build.mjs --installer /path/to/WorkBuddy-*.exe
# 升级到官方最新版: node build.mjs --force-download
# 构建后一键验证: node verify-build.mjs   (语法检查 + 19 项冒烟测试 + asar 校验)
```

产物在 `dist/HeadlessWB/`。构建需要 Node 18+ 与网络（自动下载官方安装包，
自动安装 @electron/asar 与 7z-bin）。

## 部署（Windows，目标机 = 用户自己的雷蛇）

1. 把 `dist/HeadlessWB` 整个目录拷到目标机（建议放 `C:\ProgramData` 或用户目录，
   但**不要放桌面**，桌面图标等于暴露）。
2. 在该目录内右键 `install.ps1` → “使用 PowerShell 运行”，或：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```
   （从 GitHub 仓库部署时，用 `tools\deploy.ps1` 一条命令完成合并分卷→解压→安装）
3. 浏览器会自动弹出官方登录页，扫码登录后即进入完全静默状态。

### 干净新机自包含（无需装任何东西）

产物对**完全干净的 Windows 10/11** 也开箱即用：

- Electron + 所有资源已整目录打包，**不依赖原版 WorkBuddy 安装**；
- 原生模块依赖的 **VC++ 运行库**（`vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll`）
  已打入应用根目录，新机无需装 Visual C++ Redistributable；
- `install.ps1` 会自动 `Unblock-File` 去掉网络下载文件的 SmartScreen 标记；
- 唯一要求：**Windows 10 或 11**（Win7/8 缺 UCRT，不支持）。

## 日常命令

```powershell
.\tools\wb-ctl.ps1 status   # 查看状态
.\tools\wb-ctl.ps1 show     # 临时显示 GUI（调试用）
.\tools\wb-ctl.ps1 login    # 重新打开浏览器登录
.\tools\wb-ctl.ps1 stop     # 停止
.\tools\wb-ctl.ps1 start    # 静默启动
```

## 行为约定

| 模式 | 行为 |
|------|------|
| 默认 / `--headless` | 无窗口、无托盘、无通知、无任务栏闪烁，常驻后台，可被手机远控 |
| `--login` | 同上，但启动约 12 秒后自动打开系统浏览器登录页 |
| `--show` | 真实显示主窗口（调试；关闭窗口进程仍存活） |
| `--status` | 打印状态到 stdout 后立即退出 |

- 开机自启：`HKCU\...\Run` 键，值 `"<路径>\HeadlessWB.exe" --headless`。
- 自动更新：已禁用（含强制升级）。升级需重新跑 `build.mjs` 生成新版本后重装。
- 危险操作二次确认：走 WorkBuddy 手机端通道；桌面端永远不弹任何确认框。

## 已知限制（首次部署时需在目标机实测确认）

1. `--login` 的“自动点登录按钮 → 打开浏览器”依赖渲染页按钮文案（“登录”等），
   若官方改版导致按钮未命中，会自动兜底打开 `https://www.workbuddy.cn/login`。
   观察日志：`~/.workbuddy/logs/headlesswb/patch.log`。
2. 提示音静音依赖主进程层拦截；若仍有个别提示音（无窗口时基本不触发），
   需在 session 层追加静音。
3. 杀软可能对未签名自启 exe 提示，建议在 Windows 安全中心对
   `dist/HeadlessWB` 目录添加排除项。

## 目录结构

```
HeadlessWB/
├── build.mjs            # 构建管线（下载→解包→asar打补丁→重打包→改名→组装）
├── patch/headless-patch.js  # 运行时补丁（核心）
├── install.ps1 / uninstall.ps1
├── tools/wb-ctl.ps1
├── docs/specs/2026-11-22-headless-workbuddy-design.md  # 方案文档
└── dist/HeadlessWB/     # 产物（git 忽略）
```
