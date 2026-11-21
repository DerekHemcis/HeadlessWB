# HeadlessWB 终端控制工具
# 用法:  wb-ctl.ps1 <status|show|login|stop|start>
param([string]$Command = 'status')

$ErrorActionPreference = 'SilentlyContinue'

# 清掉会让 Electron 退化成纯 Node 的环境变量
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path (Split-Path -Parent $dir) 'HeadlessWB.exe'   # tools/wb-ctl.ps1 -> ../HeadlessWB.exe
if (-not (Test-Path $exe)) { $exe = Join-Path $dir 'HeadlessWB.exe' }  # 同级兜底
if (-not (Test-Path $exe)) { Write-Error "未找到 HeadlessWB.exe"; exit 1 }

switch ($Command) {
  'status' {
    # Electron 是 GUI 子系统程序，stdout 在终端里看不到，所以读 status.json
    $logDir = Join-Path $env:USERPROFILE '.workbuddy\logs\headlesswb'
    $statusFile = Join-Path $logDir 'status.json'
    if (Test-Path $statusFile) { Remove-Item $statusFile -Force -ErrorAction SilentlyContinue }
    $proc = Start-Process -FilePath $exe -ArgumentList '--status' -PassThru -Wait -WindowStyle Hidden
    Start-Sleep -Milliseconds 300
    if (Test-Path $statusFile) {
      Get-Content $statusFile -Raw
    } else {
      Write-Host "status.json 未生成（退出码 $($proc.ExitCode)），请查看 $logDir\patch.log"
    }
  }
  'show' {
    Start-Process -FilePath $exe -ArgumentList '--show'
    Write-Host '已请求显示 GUI（若进程未运行会先启动）'
  }
  'login' {
    Start-Process -FilePath $exe -ArgumentList '--login'
    Write-Host '已请求打开浏览器登录页'
  }
  'start' {
    Start-Process -FilePath $exe -ArgumentList '--headless'
    Write-Host '已启动（静默后台）'
  }
  'stop' {
    Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host '已停止'
  }
  default {
    Write-Host "用法: wb-ctl.ps1 <status|show|login|stop|start>"
  }
}
