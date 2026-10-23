# 构建 x.erp 安卓客户端：dist\xerp-<版本>-android.apk
# 需要：JDK 17+（JAVA_HOME）、Android SDK（platforms;android-36、build-tools;36.1.0），不需要 Gradle / Android Studio
# 签名密钥：%USERPROFILE%\.xerp-android\release.jks（首次构建自动生成；务必备份，丢了以后就没法覆盖升级）
$ErrorActionPreference = 'Stop'
$Root  = Split-Path $PSScriptRoot -Parent
$And   = $PSScriptRoot
$B     = Join-Path $And 'build'
$Dist  = Join-Path $Root 'dist'
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Run($exe) { & $exe @args; if ($LASTEXITCODE -ne 0) { throw "$exe 失败（$LASTEXITCODE）" } }

$Sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Sdk) { throw '找不到 Android SDK' }
$Bt = Join-Path $Sdk 'build-tools\36.1.0'
$AndroidJar = Join-Path $Sdk 'platforms\android-36\android.jar'
if (-not (Test-Path $AndroidJar) -or -not (Test-Path $Bt)) { throw '缺少 platforms;android-36 或 build-tools;36.1.0，请用 sdkmanager 安装' }
$Jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Split-Path (Split-Path (Get-Command javac).Source) }
$env:JAVA_HOME = $Jdk
$Zxing = Join-Path $And 'libs\zxing-core-3.5.3.jar'

# 版本与服务端一致：1.0.4 → versionCode 10004
$Version = [regex]::Match((Get-Content (Join-Path $Root 'src\server.js') -Raw), "const VERSION = '([\d.]+)'").Groups[1].Value
$v = $Version.Split('.') | ForEach-Object { [int]$_ }
$VersionCode = $v[0] * 10000 + $v[1] * 100 + $v[2]

Step "Building x.erp Android $Version ($VersionCode)"
Remove-Item $B -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $B, $Dist, "$B\gen", "$B\classes", "$B\dex" | Out-Null
Copy-Item (Join-Path $And 'res') "$B\res" -Recurse

# ---------- 1. 启动图标（与飞牛 / Windows 版同一个图案） ----------
Step 'Generating launcher icons'
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
  New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
  $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
@{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }.GetEnumerator() | ForEach-Object { New-Icon $_.Value "$B\res\mipmap-$($_.Key)\ic_launcher.png" }

# ---------- 2. 资源 ----------
Step 'aapt2 compile / link'
Run (Join-Path $Bt 'aapt2.exe') compile --dir "$B\res" -o "$B\res.zip"
Run (Join-Path $Bt 'aapt2.exe') link -o "$B\base.apk" -I $AndroidJar --manifest (Join-Path $And 'AndroidManifest.xml') --java "$B\gen" `
  --version-code $VersionCode --version-name $Version --min-sdk-version 24 --target-sdk-version 36 "$B\res.zip"

# ---------- 3. Java → class → dex ----------
Step 'javac'
$srcs = @(Get-ChildItem (Join-Path $And 'src'), "$B\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
Run (Join-Path $Jdk 'bin\javac.exe') -nowarn '-Xlint:-options' -encoding UTF-8 -source 8 -target 8 -bootclasspath "$AndroidJar;$(Join-Path $Bt 'core-lambda-stubs.jar')" -classpath $Zxing -d "$B\classes" @srcs
Step 'd8'
$classes = @(Get-ChildItem "$B\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
Run (Join-Path $Bt 'd8.bat') --release --min-api 24 --lib $AndroidJar --output "$B\dex" @classes $Zxing

# ---------- 4. 打包、对齐、签名 ----------
Step 'Packaging'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
Copy-Item "$B\base.apk" "$B\unsigned.apk"
$zip = [IO.Compression.ZipFile]::Open("$B\unsigned.apk", 'Update')
Get-ChildItem "$B\dex" -Filter *.dex | ForEach-Object { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $_.Name) | Out-Null }
$zip.Dispose()
Run (Join-Path $Bt 'zipalign.exe') -f -p 4 "$B\unsigned.apk" "$B\aligned.apk"

$KeyDir = Join-Path $env:USERPROFILE '.xerp-android'
$Ks = Join-Path $KeyDir 'release.jks'; $KsProps = Join-Path $KeyDir 'keystore.properties'
if (-not (Test-Path $Ks)) {
  Step 'Creating release keystore (back it up!)'
  New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
  $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  Run (Join-Path $Jdk 'bin\keytool.exe') -genkeypair -keystore $Ks -alias xerp -keyalg RSA -keysize 3072 -validity 18250 -storepass $pw -keypass $pw -dname 'CN=x.erp, O=x.erp, C=CN'
  Set-Content -Path $KsProps -Value "storePassword=$pw" -Encoding ASCII
}
$pw = (@(Get-Content $KsProps | Where-Object { $_ -match '^storePassword=' })[0] -replace '^storePassword=', '').Trim()
$Apk = Join-Path $Dist "xerp-$Version-android.apk"
Step 'Signing'
Run (Join-Path $Bt 'apksigner.bat') sign --ks $Ks --ks-key-alias xerp --ks-pass "pass:$pw" --key-pass "pass:$pw" --out $Apk "$B\aligned.apk"
Run (Join-Path $Bt 'apksigner.bat') verify $Apk
Step ("Done: $Apk ({0:N1} MB)" -f ((Get-Item $Apk).Length / 1MB))
