# HeadlessWB 安装程序（由自解压 exe 调用）
# 职责：把 SFX 解压出来的文件复制到最终安装目录，然后调用 install.ps1 完成注册与启动。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$msg) { Write-Host "  $msg" }

try {
    Write-Host ''
    Write-Host '=========================================='
    Write-Host '   HeadlessWB 安装程序'
    Write-Host '=========================================='
    Write-Host ''

    # ---- 0. 确定源目录（SFX 临时解压目录）与目标目录 ----
    $src = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not (Test-Path (Join-Path $src 'HeadlessWB.exe'))) {
        # 兼容 zip 内多一层 HeadlessWB\ 的情况
        $nested = Join-Path $src 'HeadlessWB'
        if (Test-Path (Join-Path $nested 'HeadlessWB.exe')) { $src = $nested }
        else { throw "安装包不完整：未找到 HeadlessWB.exe（源目录 $src）" }
    }

    $dst = Join-Path $env:USERPROFILE 'HeadlessWB'

    # ---- 1. 路径长度保护（产物内最长相对路径 209 字符）----
    $maxRel = 209
    $total = $dst.Length + 1 + $maxRel
    Write-Host "[1/5] 安装目录: $dst"
    Write-Step "最长路径估算: $total 字符（Windows 限制 260）"
    if ($total -gt 255) {
        throw "安装路径过长（$total 字符），请把用户目录移到更短的路径后重试。"
    }

    # ---- 2. 停止可能占用文件的进程 ----
    Write-Host '[2/5] 停止旧进程...'
    foreach ($n in @('HeadlessWB', 'WorkBuddy', 'RepairApp', 'workbuddy-editor-sdk-supervisor')) {
        Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

    # ---- 3. 复制文件（带重试，防止残留句柄）----
    Write-Host '[3/5] 复制文件...'
    $copied = $false
    for ($try = 1; $try -le 3; $try++) {
        try {
            if (Test-Path $dst) {
                Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
                $left = @(Get-ChildItem $dst -Force -ErrorAction SilentlyContinue)
                if ($left.Count -gt 0) { throw "旧目录未能清空（剩 $($left.Count) 项）" }
            }
            New-Item -ItemType Directory -Path $dst -Force | Out-Null
            Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
            $copied = $true
            break
        } catch {
            Write-Step "第 $try 次复制失败: $($_.Exception.Message)"
            Start-Sleep -Seconds 2
        }
    }
    if (-not $copied) { throw '复制文件失败（可能有进程占用安装目录）' }

    $fileCount = @(Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Step "已复制 $fileCount 个文件"

    # ---- 4. 校验关键文件 ----
    Write-Host '[4/5] 校验产物...'
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
        if (-not (Test-Path (Join-Path $dst $rel))) { $missing += $rel }
    }
    if ($missing.Count -gt 0) { throw ("缺少关键文件: " + ($missing -join ', ')) }
    Write-Step '关键文件齐全'

    # BUILD-INFO（便于核对版本）
    $bi = Join-Path $dst 'BUILD-INFO.json'
    if (Test-Path $bi) {
        try {
            $info = Get-Content $bi -Raw | ConvertFrom-Json
            Write-Step "版本 $($info.appVersion) / commit $($info.gitCommit)"
        } catch {}
    }

    # ---- 5. 执行安装（写自启 + 启动）----
    Write-Host '[5/5] 注册开机自启并启动...'
    & (Join-Path $dst 'install.ps1')

    Write-Host ''
    Write-Host '=========================================='
    Write-Host '   安装完成'
    Write-Host '=========================================='
    Write-Host ''
    Write-Host '  · 软件已在后台静默运行（无窗口/无托盘/无通知）'
    Write-Host '  · 手机 WorkBuddy App（同账号）即可远程操控本机'
    Write-Host ''
    Write-Host '  常用命令（在安装目录下）：'
    Write-Host '    tools\wb-ctl.ps1 status   查看状态'
    Write-Host '    tools\wb-ctl.ps1 show     临时显示界面'
    Write-Host '    tools\wb-ctl.ps1 login    重新登录'
    Write-Host '    tools\wb-ctl.ps1 stop     停止运行'
    Write-Host ''
    Write-Host '  日志：%USERPROFILE%\.workbuddy\logs\headlesswb\patch.log'
    Write-Host ''
    Write-Host '  按任意键关闭本窗口...'
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 5 }
}
catch {
    Write-Host ''
    Write-Host '==========================================' -ForegroundColor Red
    Write-Host '   安装失败' -ForegroundColor Red
    Write-Host '==========================================' -ForegroundColor Red
    Write-Host ''
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host '  排查建议：'
    Write-Host '    1) 关闭杀毒软件后重试'
    Write-Host '    2) 确认没有其他 WorkBuddy/HeadlessWB 在运行'
    Write-Host '    3) 检查磁盘剩余空间（需 2GB 以上）'
    Write-Host ''
    Write-Host '  按任意键关闭...'
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 10 }
    exit 1
}
