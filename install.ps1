# HeadlessWB 安装脚本（用户级，无需管理员）
# 在 HeadlessWB 目录内右键“使用 PowerShell 运行”，或：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'HeadlessWB.exe'
if (-not (Test-Path $exe)) { Write-Error "未找到 $exe"; exit 1 }

# 去掉 Mark-of-the-Web（浏览器/网络下载文件的 SmartScreen 标记），避免首次运行被拦
Unblock-File -Path $exe -ErrorAction SilentlyContinue
Get-ChildItem -Path $dir -Filter '*.dll' -ErrorAction SilentlyContinue | ForEach-Object { Unblock-File -Path $_.FullName -ErrorAction SilentlyContinue }

# 0) 停掉可能冲突的原版 WorkBuddy / 旧 HeadlessWB 进程
#    （两者共用同一 userData，Electron 单实例锁会互斥，必须只留一个）
foreach ($name in @('WorkBuddy', 'HeadlessWB', 'RepairApp', 'workbuddy-editor-sdk-supervisor')) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
}
Write-Host '[0/4] 已停止可能冲突的 WorkBuddy/HeadlessWB 进程'

# 1) 清掉原版 WorkBuddy 的自启键（Run 键名可能是 WorkBuddy 或 WorkBuddy.WorkBuddy），
#    避免开机后原版与无头版同时启动互抢单实例锁
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
foreach ($name in @('WorkBuddy', 'WorkBuddy.WorkBuddy')) {
  Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
}

# 2) 写入我们的自启键：HeadlessWB.exe --headless（静默后台）
$value  = '"' + $exe + '" --headless'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'HeadlessWB' -PropertyType String -Value $value -Force | Out-Null
Write-Host "[1/4] 已注册开机自启 (HKCU Run): $value"

# 3) 首次启动：拉起 daemon 并自动打开浏览器登录页
#    某些终端/IDE 环境会带 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node，
#    表现为 "bad option: --login"。启动前必须清掉。
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Write-Host '      已清除 ELECTRON_RUN_AS_NODE'
}
if (Test-Path Env:ELECTRON_NO_ATTACH_CONSOLE) {
  Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
}
Write-Host '[2/4] 启动 HeadlessWB 并打开浏览器登录页...'
Start-Process -FilePath $exe -ArgumentList '--login'

# 3.1) 启动自检：15 秒后确认进程真的活着，避免"看起来装好了其实秒退"
Write-Host '[3/4] 等待 15 秒做启动自检...'
Start-Sleep -Seconds 15
$alive = Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue
$logFile = Join-Path $env:USERPROFILE '.workbuddy\logs\headlesswb\patch.log'
if ($alive) {
  $count = ($alive | Measure-Object).Count
  Write-Host "      启动成功：HeadlessWB 进程 $count 个"
} else {
  Write-Warning '启动失败：15 秒后没有 HeadlessWB 进程'
  Write-Host '      常见原因：被杀软拦截、解压不完整、原版 WorkBuddy 抢单实例锁'
  if (Test-Path $logFile) {
    Write-Host "      补丁日志最后 20 行（$logFile）："
    Get-Content $logFile -Tail 20 | ForEach-Object { Write-Host "        $_" }
  } else {
    Write-Host "      未生成补丁日志（$logFile），说明补丁没被加载，重试用 deploy.ps1 完整重装"
  }
}

# 4) 提示
Write-Host '[4/4] 安装流程结束。请在浏览器中扫码登录。'
Write-Host ''
Write-Host '说明:'
Write-Host '  - 登录成功后软件完全静默后台运行，无窗口/托盘/通知'
Write-Host '  - 用手机 WorkBuddy App(同账号) 即可远程操控这台电脑'
Write-Host '  - 常用命令:'
Write-Host "      wb-ctl.ps1 status   # 查看状态"
Write-Host "      wb-ctl.ps1 show     # 临时显示 GUI(调试)"
Write-Host "      wb-ctl.ps1 login    # 重新打开浏览器登录"
Write-Host "      wb-ctl.ps1 stop     # 停止后台进程"
Write-Host "      verify.ps1         # 部署自检（把输出发回来可远程收尾）"
