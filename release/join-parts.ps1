# HeadlessWB 分卷合并脚本（在雷蛇上运行）
# 把 release/parts/ 下的 HeadlessWB.zip.part-* 合并成 HeadlessWB.zip
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\release\join-parts.ps1
$ErrorActionPreference = 'Stop'

$partsDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'parts'
$outZip   = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'HeadlessWB.zip'

$parts = Get-ChildItem -Path $partsDir -Filter 'HeadlessWB.zip.part-*' | Sort-Object Name
if ($parts.Count -eq 0) { Write-Error "未找到分卷文件：$partsDir" }

Write-Host "合并 $($parts.Count) 个分卷 -> $outZip ..."
$fs = [System.IO.File]::Open($outZip, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  foreach ($p in $parts) {
    $bytes = [System.IO.File]::ReadAllBytes($p.FullName)
    $fs.Write($bytes, 0, $bytes.Length)
    Write-Host ("  + {0} ({1:N1} MB)" -f $p.Name, ($bytes.Length / 1MB))
  }
} finally {
  $fs.Close()
}

$expected = 586126433
$actual = (Get-Item $outZip).Length
Write-Host ("合并完成: {0} 字节" -f $actual)
if ($actual -ne $expected) { Write-Warning "大小与预期($expected)不一致，合并可能损坏，请重新 clone 后重试" }
