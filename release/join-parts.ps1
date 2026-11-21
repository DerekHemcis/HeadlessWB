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

$expectedSize = 586133143
$expectedSha  = 'BB34932E81BB444B5438BEB9B75A0DA5C6DA6CC60E960E6AE835D2F15398D798'

$actualSize = (Get-Item $outZip).Length
Write-Host ("合并完成: {0} 字节 (预期 {1})" -f $actualSize, $expectedSize)
if ($actualSize -ne $expectedSize) {
  Write-Error "大小不一致，合并可能损坏。请确认分卷完整（应 7 个 part）后重试。"
}

Write-Host '校验 SHA256 ...'
$actualSha = (Get-FileHash -Path $outZip -Algorithm SHA256).Hash
Write-Host "  实际: $actualSha"
Write-Host "  预期: $expectedSha"
if ($actualSha -ne $expectedSha) {
  Write-Error "SHA256 不匹配，zip 损坏。请重新 clone 仓库后重试。"
}
Write-Host '分卷完整、校验通过 ✅'
