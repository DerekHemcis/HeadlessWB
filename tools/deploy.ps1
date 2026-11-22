# HeadlessWB 一键部署（合并分卷 → 解压 → 安装）
# 用法（在仓库里任意位置执行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\xuesh\HeadlessWB-repo\tools\deploy.ps1
# 可选参数：
#   -InstallDir "C:\Users\xuesh\HeadlessWB"   安装目录（默认就是这个，别改到更深的路径）
#   -NoInstall                                 只解压，不执行 install.ps1
param(
  [string]$InstallDir = '',
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

# ---- 0. 定位仓库根目录（本脚本在 tools\ 下） ----
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir  = Split-Path -Parent $toolsDir
Write-Host "[0/5] 仓库目录: $repoDir"

if (-not $InstallDir -or $InstallDir -eq '') {
  $InstallDir = Join-Path $env:USERPROFILE 'HeadlessWB'
}
Write-Host "      安装目录: $InstallDir"

# ---- 1. Windows 路径长度保护（历史最长相对路径 209 字符） ----
$maxRelPath = 209
$totalLen = $InstallDir.Length + 1 + $maxRelPath
Write-Host "[1/5] 最长路径估算: $totalLen 字符（Windows 限制 260）"
if ($totalLen -gt 250) {
  throw "安装目录太深，解压会触发 Windows 路径长度限制。请改用更短的目录，例如 $env:USERPROFILE\HeadlessWB"
}

# ---- 2. 合并分卷（含 SHA256 校验） ----
$joinScript = Join-Path $repoDir 'release\join-parts.ps1'
if (-not (Test-Path $joinScript)) { throw "未找到 $joinScript（仓库不完整？）" }
Write-Host '[2/5] 合并分卷并校验...'
$zip = Join-Path $repoDir 'release\HeadlessWB.zip'
& $joinScript
# 注意：join-parts.ps1 只用 cmdlet，不含原生进程，$LASTEXITCODE 可能保持 $null，
# 而 PowerShell 里 ($null -ne 0) 为 $true，直接判断会必错。这里三重判定。
$joinOk = $?
$exitCode = $LASTEXITCODE
if (-not $joinOk) { throw '分卷合并失败（见上方输出）' }
if (($null -ne $exitCode) -and ($exitCode -ne 0)) { throw "分卷合并失败，退出码 $exitCode" }
if (-not (Test-Path $zip)) { throw "分卷合并后未生成 $zip" }

# ---- 3. 停掉正在运行的旧进程（文件被占用会导致解压失败） ----
Write-Host '[3/5] 停止可能占用文件的进程...'
foreach ($name in @('HeadlessWB', 'WorkBuddy', 'RepairApp', 'workbuddy-editor-sdk-supervisor')) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# ---- 4. 解压 ----
Write-Host '[4/5] 解压...'
if (Test-Path $InstallDir) {
  Write-Host "      目标目录已存在，清理旧文件: $InstallDir"
  $cleared = $false
  for ($try = 1; $try -le 3; $try++) {
    # 每轮先把可能锁定文件的进程再杀一次（RepairApp.exe 会加载 Newtonsoft.Json.dll）
    foreach ($pn in @('HeadlessWB', 'RepairApp', 'workbuddy-editor-sdk-supervisor', 'WorkBuddy')) {
      Get-Process -Name $pn -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800
    Remove-Item -Path (Join-Path $InstallDir '*') -Recurse -Force -ErrorAction SilentlyContinue
    $left = @(Get-ChildItem -Path $InstallDir -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) { $cleared = $true; break }
    Write-Warning "      第 $try 次清理后仍剩 $($left.Count) 个文件（可能被占用），重试..."
  }
  if (-not $cleared) {
    $left = @(Get-ChildItem -Path $InstallDir -Force -ErrorAction SilentlyContinue | Select-Object -First 8 | ForEach-Object { $_.Name })
    throw ("无法清空安装目录（文件被占用）。残留示例: " + ($left -join ', ') + "。请手工结束 RepairApp/HeadlessWB 进程后重试。")
  }
} else {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$expanded = $false
try {
  Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
  $expanded = $true
  Write-Host '      Expand-Archive 完成'
} catch {
  Write-Warning "Expand-Archive 失败: $($_.Exception.Message)"
  Write-Host '      改用 tar 解压 ...'
  & tar.exe -xf $zip -C $InstallDir
  if ($LASTEXITCODE -ne 0) { throw 'tar 解压也失败，请检查磁盘空间与路径长度' }
  $expanded = $true
  Write-Host '      tar 解压完成'
}
if (-not $expanded) { throw '解压失败' }

# ---- 4.5 兼容 zip 内多一层 HeadlessWB\ 目录 ----
$nested = Join-Path $InstallDir 'HeadlessWB'
if ((Test-Path (Join-Path $nested 'HeadlessWB.exe')) -and -not (Test-Path (Join-Path $InstallDir 'HeadlessWB.exe'))) {
  Write-Host "      检测到多一层目录，正在上移: $nested"
  Get-ChildItem -Path $nested -Force | ForEach-Object {
    Move-Item -Path $_.FullName -Destination $InstallDir -Force
  }
  Remove-Item -Path $nested -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '      已展开为单层目录'
}

# ---- 5. 校验关键文件并安装 ----
Write-Host '[5/5] 校验产物...'
$required = @(
  'HeadlessWB.exe',
  'resources\app.asar',
  'resources\headless-patch.js',
  'install.ps1',
  'tools\wb-ctl.ps1',
  'tools\verify.ps1',
  'vcruntime140.dll'
)
$missing = @()
foreach ($rel in $required) {
  $p = Join-Path $InstallDir $rel
  if (-not (Test-Path $p)) { $missing += $rel }
}
if ($missing.Count -gt 0) {
  throw ("解压后缺少关键文件: " + ($missing -join ', '))
}
Write-Host '      关键文件齐全 ✅'

# 解压后比对补丁与仓库源码（防止"产物与 commit 不一致"再次发生）
$srcPatch = Join-Path $repoDir 'patch\headless-patch.js'
$dstPatch = Join-Path $InstallDir 'resources\headless-patch.js'
if ((Test-Path $srcPatch) -and (Test-Path $dstPatch)) {
  $h1 = (Get-FileHash $srcPatch -Algorithm SHA256).Hash
  $h2 = (Get-FileHash $dstPatch -Algorithm SHA256).Hash
  if ($h1 -ne $h2) {
    throw "交付包补丁与仓库源码不一致（src=$($h1.Substring(0,16)) dist=$($h2.Substring(0,16))），拒绝继续"
  }
  Write-Host '      补丁与源码一致 ✅'
} else {
  Write-Host '      （跳过补丁比对：逐卷下载模式无 patch/ 目录）'
}

# 打印 BUILD-INFO（若有）
$bi = Join-Path $InstallDir 'BUILD-INFO.json'
if (Test-Path $bi) {
  Write-Host '      BUILD-INFO:'
  Get-Content $bi -Raw | Write-Host
}

if ($NoInstall) {
  Write-Host ''
  Write-Host "已完成解压（-NoInstall）。下一步手动执行:"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\install.ps1`""
  exit 0
}

Write-Host ''
Write-Host '执行安装（写自启 + 启动 + 打开浏览器登录页）...'
& (Join-Path $InstallDir 'install.ps1')
Write-Host ''
Write-Host '部署完成。等待约 60 秒后运行自检:'
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\tools\verify.ps1`""
