# HeadlessWB 雷蛇真机测试流程（DSH 自动执行版）

> 目标：在雷蛇（Windows）上部署 HeadlessWB 无头版，自动完成技术校验，并把结果打包发回。
> 执行者：雷蛇上的 DSH agent。测试中唯一需要**用户本人**动手的是「浏览器扫码登录」和「手机 App 远控确认」。
> 支持范围：完全干净的 Windows 10/11 新机也开箱即用（Electron 自包含 + VC++ 运行库已打入包内 + install.ps1 自动去 SmartScreen 标记）。

---

## ⚡ 直接粘贴给雷蛇 DSH 的指令（推荐）

> 下面整段复制给雷蛇上的 DSH 即可，它会自行按本文件执行。

```
请在这台 Windows 上部署并测试 HeadlessWB（WorkBuddy 无头隐蔽版）。严格按仓库里的流程文档执行，不要自行改代码。

步骤：
1. 克隆仓库：git clone https://github.com/DerekHemcis/HeadlessWB.git C:\Users\xuesh\HeadlessWB-repo
2. 通读 C:\Users\xuesh\HeadlessWB-repo\docs\razor-test-procedure.md，然后严格照它执行（它会让你合并分卷、解压、装自启、跑校验）。
3. 合并分卷必须成功（SHA256 校验通过），解压到 C:\Users\xuesh\HeadlessWB。
4. 执行 install.ps1 后等 60 秒，然后运行 tools\verify.ps1 并把 JSON 输出完整保留。
5. 遇到需要人操作的两处，把问题抛给我（用户）并等我回复：
   a) 浏览器弹出登录页时，需要我扫码；
   b) 手机 App 远控确认。
6. 全部跑完后，按文档第 8 节把六块结果汇总输出给我，另外附上 patch.log 最后 120 行。

注意：这台机器的 PowerShell 是 5.1，没有 pwsh，请用全路径 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe。
如果哪一步失败，不要重试超过 2 次，把原始报错和 patch.log 一起返回。
```

---

## 0. 前置条件

1. 雷蛇上有 git 和 PowerShell 5.1（雷蛇没有 pwsh，全路径见下）。
2. 原版 WorkBuddy 已卸载（用户已确认）。

### 0.1 拉取仓库并合并分卷

```powershell
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
git clone https://github.com/DerekHemcis/HeadlessWB.git C:\Users\xuesh\HeadlessWB-repo
```

合并分卷（交付 zip 约 559 MiB，切成 7 个 ≤90MB 的 part，避免 GitHub 100MB 单文件限制）：

```powershell
& $P -NoProfile -ExecutionPolicy Bypass -File "C:\Users\xuesh\HeadlessWB-repo\release\join-parts.ps1"
```

合并后应得到 `release\HeadlessWB.zip`，大小 **586,129,837 字节**（脚本会校验并告警）。

### 0.2 解压到稳定目录

```powershell
$ZipPath    = 'C:\Users\xuesh\HeadlessWB-repo\release\HeadlessWB.zip'
$InstallDir = 'C:\Users\xuesh\HeadlessWB'
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $InstallDir -Force
Get-Item "$InstallDir\HeadlessWB.exe" | Select-Object Length   # 约 204 MB
Get-Item "$InstallDir\resources\app.asar" | Select-Object Length # 约 165 MB
```

**注意**：安装目录固定用 `C:\Users\xuesh\HeadlessWB`（不要放桌面、不要放 repo 里，否则开机自启失效）。

---

## 1. 安装（写自启 + 首次启动 + 触发浏览器登录）

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\xuesh\HeadlessWB\install.ps1"
```

**记录 install.ps1 的完整输出**（一会儿要发回）。期待看到：
```
[0/4] 已停止可能冲突的 WorkBuddy/HeadlessWB 进程
[1/4] 已注册开机自启 (HKCU Run): "C:\Users\xuesh\HeadlessWB\HeadlessWB.exe" --headless
[2/4] 启动 HeadlessWB 并打开浏览器登录页...
[3/4] 完成。请在浏览器中扫码登录。
```

### 1.1 等 60 秒（给 daemon 起来 + 首轮更新检查触发 + 登录页弹出）

```powershell
Start-Sleep -Seconds 60
```

---

## 3. 基础技术校验（全自动）

先跑自检脚本拿 JSON（含 VC++ 运行库检查）：

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\xuesh\HeadlessWB\tools\verify.ps1"
```

再把下面一整段**复制进一个 PowerShell 窗口**跑，输出全部记下来：

```powershell
$InstallDir = 'C:\Users\xuesh\HeadlessWB'
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

Write-Host '===== 1. 进程 ====='
Get-Process -Name 'HeadlessWB','WorkBuddy' -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,MainWindowTitle

Write-Host '===== 2. Run 键 ====='
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
  Select-Object HeadlessWB, WorkBuddy, 'WorkBuddy.WorkBuddy'

Write-Host '===== 3. 补丁日志 ====='
$log = "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log"
if (Test-Path $log) { Get-Content $log -Tail 40 } else { Write-Host '<patch.log 不存在>' }

Write-Host '===== 4. 用户数据目录 ====='
Get-ChildItem "$env:USERPROFILE\.workbuddy" -ErrorAction SilentlyContinue | Select-Object Name

Write-Host '===== 5. 关键日志行（必须全部出现）====='
Select-String -Path $log -Pattern 'patch loaded','electron require shim installed','net.fetch patched','Tray','Notification' | Select-Object -Last 10
```

**判定标准**：
- 第 1 项：有 `HeadlessWB` 进程（可能多个，Electron 多进程正常），`MainWindowTitle` 应为空；**不应有 `WorkBuddy` 进程**。
- 第 2 项：`HeadlessWB` 有值（指向 HeadlessWB.exe --headless）；`WorkBuddy`、`WorkBuddy.WorkBuddy` 为空。
- 第 3/5 项：日志里出现 `patch loaded`、`electron require shim installed`、`net.fetch patched`。
- 第 4 项：`.workbuddy` 下应有 `logs\`（若用户在旧版卸载时勾选了删数据，可能没有 `memory\`，属正常）。

---

## 4. 隐蔽性检查

**自动可查**：
```powershell
# 无可见窗口：MainWindowTitle 应为空（已在第 3 节第 1 项里）
# 无任务栏按钮：同上，MainWindowHandle 为空即无窗口
Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue | Select-Object Id,MainWindowHandle,MainWindowTitle
```

**需用户肉眼确认（agent 无法自动看托盘）**，让用户回答三句：
1. 任务栏右下角有没有 WorkBuddy / HeadlessWB 图标？（应为**没有**）
2. Windows 通知中心有没有 WorkBuddy 通知？（应为**没有**）
3. 任务栏有没有 WorkBuddy 窗口按钮？（应为**没有**）

---

## 5. 登录（需要用户扫码）

1. install.ps1 启动后约 12 秒，**默认浏览器应自动弹出**官方登录页 `https://www.workbuddy.cn/console/client-login?...`。
2. 若**没弹**：先看日志里的 login 尝试：
   ```powershell
   Select-String -Path "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log" -Pattern 'login' | Select-Object -Last 15
   ```
   然后手动补触发：
   ```powershell
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\xuesh\HeadlessWB\tools\wb-ctl.ps1" login
   ```
3. **用户**在浏览器扫码登录。
4. 登录成功后等 15 秒，再执行：
   ```powershell
   Get-ChildItem "$env:USERPROFILE\.workbuddy\memory" -ErrorAction SilentlyContinue | Select-Object Name
   Select-String -Path "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log" -Pattern 'login','openExternal','client-login' | Select-Object -Last 10
   ```
   看到 `memory\` 下有 uid 文件，或日志里有 `client-login` 的 openExternal 记录，即登录链路正常。

---

## 6. wb-ctl 命令回归（自动）

```powershell
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$ctl = "C:\Users\xuesh\HeadlessWB\tools\wb-ctl.ps1"

Write-Host '===== status ====='
& $P -NoProfile -ExecutionPolicy Bypass -File $ctl status

Write-Host '===== show（应弹出 GUI 窗口，用户看一眼再继续）====='
& $P -NoProfile -ExecutionPolicy Bypass -File $ctl show
Start-Sleep -Seconds 8
# 用户确认窗口出现后，手动关掉该窗口

Write-Host '===== stop ====='
& $P -NoProfile -ExecutionPolicy Bypass -File $ctl stop
Start-Sleep -Seconds 3
Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName   # 应为空

Write-Host '===== start ====='
& $P -NoProfile -ExecutionPolicy Bypass -File $ctl start
Start-Sleep -Seconds 20
Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName   # 应恢复
```

---

## 7. 手机远控确认（用户手动）

用户用手机 WorkBuddy App（与扫码同一个账号）：
1. 应能看到这台电脑（设备在线）。
2. 发一个简单任务（如「新建一个空文件夹在桌面」），电脑应执行、手机收到结果，**电脑全程无任何弹窗**。

---

## 8. 结果打包发回

把以下**六块内容**原样发回：

1. `install.ps1` 的完整输出
2. 第 3 节「基础技术校验」的全部输出
3. 第 4 节「隐蔽性检查」的自动输出 + 用户肉眼确认的三句答案
4. 第 5 节登录后的两条命令输出
5. 第 6 节 wb-ctl 回归的全部输出
6. 第 7 节手机远控结果（成功/失败 + 现象）

一条命令把日志也带上：
```powershell
Get-Content "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log" -Tail 100
```

---

## 9. 常见失败对照（agent 自诊用）

| 现象 | 先看 | 最可能原因 |
|------|------|-----------|
| HeadlessWB 启动后秒退 | patch.log 无内容 / 报错 | 解压不完整、或旧 WorkBuddy 还在抢单实例锁（重跑 install.ps1 第 0 步） |
| patch.log 不存在 | `$env:USERPROFILE\.workbuddy\logs\headlesswb\` | 补丁没被加载 → app.asar 注入失败，重新解压完整包 |
| 托盘图标还在 | patch.log 有无 `Tray` 行 | 补丁未生效（同上） |
| 浏览器没弹登录页 | patch.log 里 `login attempt` 结果 | 按钮文案没命中 → 手动跑 `wb-ctl.ps1 login`，并把日志发回 |
| 更新检查没被拦 | patch.log 有无 `blocked update check` | 首轮检查 30 秒后触发，等 60 秒再看 |
| 手机看不到设备 | 第 5 节登录是否成功 | 账号不一致 / 登录未完成 |

> 遇到任何异常，不要自行改代码，把第 8 节的六块结果发回即可。
