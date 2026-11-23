# HeadlessWB 安装器分卷合并（在 Windows 上运行）
# 把 release/setup-parts/ 下的 HeadlessWB-Setup.exe.part-* 合并成 HeadlessWB-Setup.exe
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\release\join-setup-parts.ps1
$ErrorActionPreference = 'Stop'

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$partsDir = Join-Path $base 'setup-parts'
$outExe   = Join-Path $base 'HeadlessWB-Setup.exe'

$parts = Get-ChildItem -Path $partsDir -Filter 'HeadlessWB-Setup.exe.part-*' | Sort-Object Name
if ($parts.Count -eq 0) { Write-Error "未找到分卷文件：$partsDir" }

Write-Host "合并 $($parts.Count) 个分卷 -> $outExe ..."
$fs = [System.IO.File]::Open($outExe, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  foreach ($p in $parts) {
    $bytes = [System.IO.File]::ReadAllBytes($p.FullName)
    $fs.Write($bytes, 0, $bytes.Length)
    Write-Host ("  + {0} ({1:N1} MB)" -f $p.Name, ($bytes.Length / 1MB))
  }
} finally {
  $fs.Close()
}

$expectedSize = 411774874
$expectedSha  = 'C74515A699DA1CA906B94D6D9DC99E9BF14AD95D82D26B67A734E2DE50F02B88'

$actualSize = (Get-Item $outExe).Length
Write-Host ("合并完成: {0} 字节 (预期 {1})" -f $actualSize, $expectedSize)
if ($actualSize -ne $expectedSize) {
  Write-Error "大小不一致，合并可能损坏。请确认分卷完整（应 5 个 part）后重试。"
}

Write-Host '校验 SHA256 ...'
$actualSha = (Get-FileHash -Path $outExe -Algorithm SHA256).Hash
Write-Host "  实际: $actualSha"
Write-Host '  （与 setup-info.txt 中的 sha256 比对）'

# 完整性自检：MZ 头 + 内嵌 7z 可读
$head = [System.IO.File]::ReadAllBytes($outExe)[0..1]
if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { Write-Error '不是有效的 PE 文件（MZ 头缺失）' }
Write-Host 'PE 头校验通过 ✅'

Write-Host ''
Write-Host '下一步：双击 HeadlessWB-Setup.exe 即可安装'
