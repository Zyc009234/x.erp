# 构建 Windows 安装包：dist\xerp-<版本>-windows-x64-setup.exe
# 需要：Windows、本机已安装 Node.js（x64，会把 node.exe 一起打进安装包）、Inno Setup 6（winget install JRSoftware.InnoSetup）
$ErrorActionPreference = 'Stop'
$Root  = Split-Path $PSScriptRoot -Parent
$Win   = $PSScriptRoot
$Stage = Join-Path $Win 'build'
$Dist  = Join-Path $Root 'dist'
$Utf8Bom = New-Object Text.UTF8Encoding $true
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

$Version = [regex]::Match((Get-Content (Join-Path $Root 'src\server.js') -Raw), "const VERSION = '([\d.]+)'").Groups[1].Value
if (-not $Version) { throw '读不到 src\server.js 里的 VERSION' }

$Iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Iscc) { throw '找不到 Inno Setup 6，请先运行：winget install JRSoftware.InnoSetup' }
$Node = (Get-Command node).Source
$NodeVer = (& $Node -p process.version) + " " + (& $Node -p process.arch)
if ($NodeVer -notmatch 'x64$') { throw "需要 x64 的 Node.js，当前是 $NodeVer" }
if ([int]($NodeVer -replace '^v(\d+).*', '$1') -lt 22) { throw "需要 Node.js 22.13 以上，当前是 $NodeVer" }

# ---------- 1. 暂存 ----------
Step "Staging x.erp $Version (Node $NodeVer)"
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
$App = Join-Path $Stage 'app'
New-Item -ItemType Directory -Force -Path $App, $Dist | Out-Null
Copy-Item $Node (Join-Path $App 'node.exe')
$NodeLicense = Join-Path (Split-Path $Node) 'LICENSE'
if (Test-Path $NodeLicense) { Copy-Item $NodeLicense (Join-Path $App 'node-LICENSE.txt') }
else {  # Node.js 安装目录里没有 LICENSE 时，从官方仓库取对应版本的（MIT 要求随程序附带许可声明）
  $tag = & $Node -p process.version
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$tag/LICENSE" -OutFile (Join-Path $App 'node-LICENSE.txt')
}
Copy-Item (Join-Path $Root 'src\server.js'), (Join-Path $Root 'src\index.html') $App
Copy-Item (Join-Path $Root 'src\vendor') $App -Recurse
Copy-Item (Join-Path $Win 'xerp-service.ps1') $App
Copy-Item (Join-Path $Win 'ChineseSimplified.isl') $Stage

$readme = @"
x.erp $Version（Windows 版）

【访问】
本机：开始菜单 → x.erp → 打开 x.erp，或浏览器访问 http://127.0.0.1:端口/
局域网其他电脑：浏览器访问 http://本机IP:端口/（本机 IP 可在命令提示符里运行 ipconfig 查看）
默认端口 8686，账号 admin，密码为安装时设置的密码。

【运行方式】
x.erp 以后台服务运行（任务计划程序里名为「x.erp」的任务，以 SYSTEM 身份开机自动启动，异常退出 1 分钟后自动重启），
不需要登录 Windows，也不需要保持任何窗口打开。完全离线可用，不需要连接互联网。
安装时已在 Windows 防火墙里放行该端口，仅允许同一局域网访问。请不要把端口映射到公网。

【数据】
全部数据保存在 C:\ProgramData\XERP：
  erp.db       数据库
  backups\     每日自动备份（保留 30 天）
  logs\        运行日志
升级（直接运行新版安装包覆盖安装）和卸载都不会删除数据。

【常见问题】
打不开页面：浏览器访问 http://127.0.0.1:端口/api/ping，能看到 {"ok":true,"app":"XERP",...} 说明服务正常；
  否则查看 C:\ProgramData\XERP\logs 和 install.log。
端口被占用：重新运行安装包，在「服务设置」里换一个端口。
忘记管理员密码：用另一个管理员账号在 系统设置 → 用户管理 里重置。

反馈与更新：http://101.201.141.121/xerp/
"@
[IO.File]::WriteAllText((Join-Path $App '使用说明.txt'), ($readme -replace "`r?`n", "`r`n"), $Utf8Bom)

# ---------- 2. 图标（与飞牛版相同的图案，打成多尺寸 .ico） ----------
Step 'Generating icon'
Add-Type -AssemblyName System.Drawing
function New-IconPng($size) {
  $bmp = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([Drawing.Color]::Transparent)
  $m = [math]::Round($size * 0.06); $w = $size - 2 * $m; $r = [math]::Max(2, [math]::Round($w * 0.24))
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc($m, $m, $r, $r, 180, 90); $path.AddArc($m + $w - $r, $m, $r, $r, 270, 90)
  $path.AddArc($m + $w - $r, $m + $w - $r, $r, $r, 0, 90); $path.AddArc($m, $m + $w - $r, $r, $r, 90, 90); $path.CloseFigure()
  $rect = New-Object Drawing.Rectangle $m, $m, $w, $w
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, ([Drawing.Color]::FromArgb(99, 102, 241)), ([Drawing.Color]::FromArgb(6, 182, 212)), 45
  $g.FillPath($brush, $path)
  $font = New-Object Drawing.Font 'Arial', ([float]($size * 0.55)), ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('X', $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, ([float]($size * 0.03)), $size, $size), $fmt)
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return ,$ms.ToArray()
}
# ICO 文件：头 + 目录 + 每个尺寸一张 PNG
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = $sizes | ForEach-Object { ,(New-IconPng $_) }
$out = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$d.Length); $bw.Write([uint32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Flush(); [IO.File]::WriteAllBytes((Join-Path $Stage 'xerp.ico'), $out.ToArray())

# ---------- 3. 编译安装包（.iss 统一转成带 BOM 的 UTF-8，Inno 才能正确读中文） ----------
Step 'Compiling installer'
$iss = Join-Path $Stage 'xerp.iss'
[IO.File]::WriteAllText($iss, [IO.File]::ReadAllText((Join-Path $Win 'xerp.iss'), [Text.Encoding]::UTF8), $Utf8Bom)
& $Iscc /Q "/DAppVersion=$Version" "/DStageDir=$Stage" "/DOutDir=$Dist" $iss
if ($LASTEXITCODE -ne 0) { throw "ISCC 失败（$LASTEXITCODE）" }
$exe = Join-Path $Dist "xerp-$Version-windows-x64-setup.exe"
Step ("Done: $exe ({0:N1} MB)" -f ((Get-Item $exe).Length / 1MB))
