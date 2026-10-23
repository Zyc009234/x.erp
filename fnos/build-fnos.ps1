# 构建飞牛 fnOS 应用包：dist\xerp-<版本>.fpk（应用名“x.erp”）
# 需要：Windows、Node.js、联网（首次运行自动下载官方 fnpack 打包工具）
$ErrorActionPreference = 'Stop'
$Root   = Split-Path $PSScriptRoot -Parent
$Fnos   = $PSScriptRoot
$Stage  = Join-Path $Fnos 'build\xerp'
$Dist   = Join-Path $Root 'dist'
$Fnpack = Join-Path $Fnos 'tools\fnpack.exe'
$FnpackUrl = 'https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64'
$Utf8 = New-Object Text.UTF8Encoding $false

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# ---------- 1. 打包工具 ----------
if (-not (Test-Path $Fnpack)) {
  Step 'Downloading fnpack'
  New-Item -ItemType Directory -Force -Path (Split-Path $Fnpack) | Out-Null
  Invoke-WebRequest -Uri $FnpackUrl -OutFile $Fnpack -UseBasicParsing
}

# ---------- 2. 暂存目录 ----------
Step 'Staging package'
Remove-Item (Join-Path $Fnos 'build') -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage, $Dist | Out-Null
Copy-Item (Join-Path $Fnos 'pkg\*') $Stage -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'app\server'), (Join-Path $Stage 'app\ui\images') | Out-Null
Copy-Item (Join-Path $Root 'src\server.js'), (Join-Path $Root 'src\index.html') (Join-Path $Stage 'app\server')
Copy-Item (Join-Path $Root 'src\vendor') (Join-Path $Stage 'app\server') -Recurse

# 脚本与配置统一为 LF 换行（Linux 上执行）
Get-ChildItem $Stage -Recurse -File | Where-Object { $_.Extension -notin '.png', '.PNG' } | ForEach-Object {
  $t = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8) -replace "`r`n", "`n"
  [IO.File]::WriteAllText($_.FullName, $t, $Utf8)
}

# ---------- 3. 图标 ----------
Step 'Generating icons'
Add-Type -AssemblyName System.Drawing
function New-Icon($size, $file) {
  $bmp = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([Drawing.Color]::Transparent)
  $m = [math]::Round($size * 0.06); $w = $size - 2 * $m; $r = [math]::Round($w * 0.24)
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc($m, $m, $r, $r, 180, 90); $path.AddArc($m + $w - $r, $m, $r, $r, 270, 90)
  $path.AddArc($m + $w - $r, $m + $w - $r, $r, $r, 0, 90); $path.AddArc($m, $m + $w - $r, $r, $r, 90, 90); $path.CloseFigure()
  $rect = New-Object Drawing.Rectangle $m, $m, $w, $w
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, ([Drawing.Color]::FromArgb(99, 102, 241)), ([Drawing.Color]::FromArgb(6, 182, 212)), 45
  $g.FillPath($brush, $path)
  $font = New-Object Drawing.Font 'Arial', ([float]($size * 0.55)), ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('X', $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, ([float]($size * 0.03)), $size, $size), $fmt)
  $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
New-Icon 64  (Join-Path $Stage 'ICON.PNG')
New-Icon 256 (Join-Path $Stage 'ICON_256.PNG')
New-Icon 64  (Join-Path $Stage 'app\ui\images\icon_64.png')
New-Icon 256 (Join-Path $Stage 'app\ui\images\icon_256.png')

# ---------- 4. 打包 ----------
Step 'Building fpk'
Push-Location (Split-Path $Stage)
try {
  & $Fnpack build --directory $Stage | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'fnpack build failed' }
} finally { Pop-Location }
$fpk = Get-ChildItem (Split-Path $Stage), $Stage -Filter *.fpk -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $fpk) { throw '未找到生成的 .fpk 文件' }
$version = ((Get-Content (Join-Path $Stage 'manifest') | Where-Object { $_ -match '^\s*version\s*=' }) -split '=', 2)[1].Trim()
$final = Join-Path $Dist "xerp-$version.fpk"
Move-Item $fpk.FullName $final -Force
# 修正 Windows 打包导致的文件权限与换行
& node (Join-Path $Fnos 'fix-fpk.js') $final | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'fix-fpk failed' }
Step "Done: $final ($([math]::Round((Get-Item $final).Length / 1KB)) KB)"
