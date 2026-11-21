# HeadlessWB 卸载脚本
$ErrorActionPreference = 'SilentlyContinue'

# 1) 停止进程
Get-Process -Name 'HeadlessWB' -ErrorAction SilentlyContinue | Stop-Process -Force

# 2) 移除 Run 键
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HeadlessWB' -ErrorAction SilentlyContinue

# 3) 移除单实例锁/pid（用户数据目录保留，重装免登录）
$home = if ($env:USERPROFILE) { $env:USERPROFILE } else { (Resolve-Path ~).Path }
$pidFile = Join-Path $home '.workbuddy\logs\headlesswb\instance.pid'
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }

Write-Host 'HeadlessWB 已卸载（登录态与用户数据已保留，重装后无需重新登录）。'
