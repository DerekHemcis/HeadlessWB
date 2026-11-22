# HeadlessWB 部署自检脚本（在 Windows 上运行）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1
$ErrorActionPreference = 'SilentlyContinue'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\HeadlessWB\tools
$root = Split-Path -Parent $dir                          # ...\HeadlessWB
$exe = Join-Path $root 'HeadlessWB.exe'
$home = if ($env:USERPROFILE) { $env:USERPROFILE } else { (Resolve-Path ~).Path }

$out = [ordered]@{}

# 1) 进程
$proc = Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue
$out['processRunning'] = ($null -ne $proc)
if ($proc) { $out['pid'] = $proc.Id; $out['cpuSec'] = [math]::Round($proc.CPU, 1) }

# 2) 开机自启 Run 键
$runVal = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HeadlessWB' -ErrorAction SilentlyContinue).HeadlessWB
$out['autostartValue'] = $runVal
$oldWb1 = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'WorkBuddy' -ErrorAction SilentlyContinue).WorkBuddy
$oldWb2 = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'WorkBuddy.WorkBuddy' -ErrorAction SilentlyContinue).'WorkBuddy.WorkBuddy'
$out['legacyWorkbuddyRunKeysRemoved'] = (-not $oldWb1 -and -not $oldWb2)

# 2b) 原版 WorkBuddy 进程不应在跑（否则会抢单实例锁）
$out['originalWorkbuddyProcessRunning'] = ($null -ne (Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue))

# 2c) VC++ 运行库 DLL 应在应用根目录（干净新机自包含所需）
$vc = @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll') | ForEach-Object {
  if (Test-Path (Join-Path $root $_)) { $_ } else { "缺少:$_" }
}
$out['vcRuntimeDlls'] = $vc -join ', '

# 2d) status.json（--status 写出的结构化状态）
#     真机教训：status.json 可能是几轮之前的陈旧文件，会误导判断。
#     先主动刷新一次，再校验 runningInstance 是否真的存在于进程列表。
$statusFile = Join-Path $home '.workbuddy\logs\headlesswb\status.json'
Remove-Item $statusFile -Force -ErrorAction SilentlyContinue
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $sp = Start-Process -FilePath $exe -ArgumentList '--status' -PassThru -Wait -WindowStyle Hidden
  Start-Sleep -Milliseconds 300
  $out['statusProbeExit'] = $sp.ExitCode
} catch { $out['statusProbeError'] = $_.Exception.Message }

if (Test-Path $statusFile) {
  try {
    $st = Get-Content $statusFile -Raw | ConvertFrom-Json
    $out['status'] = $st
    $out['statusFresh'] = $true
    $liveIds = @()
    try { $liveIds = @(Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) } catch {}
    $out['statusPidIsLive'] = ($st.runningInstance -and ($liveIds -contains [int]$st.runningInstance))
  } catch { $out['status'] = 'parse-error'; $out['statusFresh'] = $false }
} else {
  $out['status'] = '<未生成>'
  $out['statusFresh'] = $false
}

# 2e) 若进程不在，主动探测一次 exe，抓住崩溃原因（如 asar 完整性 FATAL）
if (-not $out['processRunning']) {
  try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $tmpOut = Join-Path $env:TEMP ('hw_out_' + [guid]::NewGuid().ToString('N') + '.txt')
    $tmpErr = Join-Path $env:TEMP ('hw_err_' + [guid]::NewGuid().ToString('N') + '.txt')
    $proc = Start-Process -FilePath $exe -ArgumentList '--status' -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
    $out['probeExitCode'] = $proc.ExitCode
    if (Test-Path $tmpErr) {
      $err = (Get-Content $tmpErr -Raw -ErrorAction SilentlyContinue)
      if ($err) { $out['probeStderr'] = ($err -split "`n" | Select-Object -First 6) -join ' | ' }
      Remove-Item $tmpErr -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $tmpOut) { Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue }
  } catch {
    $out['probeError'] = $_.Exception.Message
  }
}

# 3) 补丁日志
$logFile = Join-Path $home '.workbuddy\logs\headlesswb\patch.log'
if (Test-Path $logFile) {
  $out['patchLogTail'] = (Get-Content $logFile -Tail 14 -Encoding UTF8) -join ' | '
  # 关键补丁已生效的证据
  $out['patchLoaded']         = [bool](Select-String -Path $logFile -Pattern 'patch loaded' -Quiet)
  $out['requireShimActive']   = [bool](Select-String -Path $logFile -Pattern 'electron require shim installed' -Quiet)
  $out['updateBlockedSeen']   = [bool](Select-String -Path $logFile -Pattern 'blocked update check' -Quiet)
  # 只看"最近一次 patch loaded"之后的日志，避免历史记录让判定恒为 true（真机反馈）
  $all = @(Get-Content $logFile -Encoding UTF8)
  $lastStart = -1
  for ($i = $all.Count - 1; $i -ge 0; $i--) {
    if ($all[$i] -match 'patch loaded') { $lastStart = $i; break }
  }
  $session = if ($lastStart -ge 0) { $all[$lastStart..($all.Count - 1)] } else { $all }
  $out['sessionLines']        = $session.Count
  $out['loginOpenedBrowser']  = [bool]($session | Select-String -Pattern 'client-login|/login\?|openExternal' -Quiet)
  $out['loginClickedAny']     = [bool]($session | Select-String -Pattern 'clicked' -Quiet)
  $out['loginSkippedSignedIn'] = [bool]($session | Select-String -Pattern 'already signed in' -Quiet)
  $out['domDump']             = (Get-Content $logFile -Encoding UTF8 | Select-String -Pattern 'DOM: url=' | Select-Object -Last 3 | ForEach-Object { $_.Line }) -join ' | '
  $out['healthSnapshot']      = (Select-String -Path $logFile -Pattern 'health\[' | Select-Object -Last 4 | ForEach-Object { $_.Line }) -join ' | '
  $out['quitSuppressed']      = [bool](Select-String -Path $logFile -Pattern 'suppressed app.quit' -Quiet)
} else {
  $out['patchLogTail'] = '<未找到日志文件>'
}

# 4) 登录数据目录（存在说明 WorkBuddy 已跑过）
$wbData = Join-Path $home '.workbuddy'
$out['workbuddyDataDir'] = (Test-Path $wbData)

# 5) 托盘/通知/窗口无法自动化检测，给出人工确认项
$out['manualChecks'] = @(
  '任务栏右下角无 WorkBuddy 图标（无托盘）',
  'Windows 通知中心无 WorkBuddy 通知',
  '任务栏/桌面无 WorkBuddy 窗口',
  '手机 WorkBuddy App(同账号) 能看到并远控这台电脑'
) -join '; '

$out['generatedAt'] = (Get-Date).ToString('o')
$out | ConvertTo-Json -Depth 4
