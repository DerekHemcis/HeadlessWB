# HeadlessWB 终端控制工具
# 用法:  wb-ctl.ps1 <status|show|login|stop|start>
param([string]$Command = 'status')

$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path (Split-Path -Parent $dir) 'HeadlessWB.exe'   # tools/wb-ctl.ps1 -> ../HeadlessWB.exe
if (-not (Test-Path $exe)) { $exe = Join-Path $dir 'HeadlessWB.exe' }  # 同级兜底
if (-not (Test-Path $exe)) { Write-Error "未找到 HeadlessWB.exe"; exit 1 }

switch ($Command) {
  'status' {
    & $exe --status
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
