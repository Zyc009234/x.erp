# Build x.erp scanner APK: dist\xerp-scanner-<version>-android.apk
# Requirements: JDK 17+ (JAVA_HOME), Android SDK (platforms;android-36, build-tools;36.1.0)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$App  = $PSScriptRoot
$B    = Join-Path $App 'build'
$Dist = Join-Path $Root 'dist'
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Run($exe) { & $exe @args; if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" } }

$Sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Sdk) { throw 'Android SDK not found' }
$Bt = Join-Path $Sdk 'build-tools\36.1.0'
$AndroidJar = Join-Path $Sdk 'platforms\android-36\android.jar'
if (-not (Test-Path $AndroidJar) -or -not (Test-Path $Bt)) { throw 'Missing platforms;android-36 or build-tools;36.1.0' }
$Jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Split-Path (Split-Path (Get-Command javac).Source) }
$env:JAVA_HOME = $Jdk
$Zxing = Join-Path $Root 'android\libs\zxing-core-3.5.3.jar'
if (-not (Test-Path $Zxing)) { throw "Missing $Zxing" }

$Version = [regex]::Match((Get-Content (Join-Path $Root 'src\server.js') -Raw), "const VERSION = '([\d.]+)'").Groups[1].Value
$v = $Version.Split('.') | ForEach-Object { [int]$_ }
$VersionCode = $v[0] * 10000 + $v[1] * 100 + $v[2]

Step "Building x.erp Scanner Android $Version ($VersionCode)"
Remove-Item $B -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $B, $Dist, "$B\gen", "$B\classes", "$B\dex" | Out-Null
Copy-Item (Join-Path $App 'res') "$B\res" -Recurse

# Generate launcher icon (emerald gradient + white barcode & check style)
Step 'Generating launcher icons'
Add-Type -AssemblyName System.Drawing
function New-ScannerIcon($size, $file) {
  $bmp = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([Drawing.Color]::Transparent)
  $m = [math]::Round($size * 0.06); $w = $size - 2 * $m; $r = [math]::Round($w * 0.24)
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc($m, $m, $r, $r, 180, 90); $path.AddArc($m + $w - $r, $m, $r, $r, 270, 90)
  $path.AddArc($m + $w - $r, $m + $w - $r, $r, $r, 0, 90); $path.AddArc($m, $m + $w - $r, $r, $r, 90, 90); $path.CloseFigure()
  $rect = New-Object Drawing.Rectangle $m, $m, $w, $w
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, ([Drawing.Color]::FromArgb(5, 150, 105)), ([Drawing.Color]::FromArgb(14, 165, 233)), 45
  $g.FillPath($brush, $path)
  # Draw crisp white barcode vertical bars + corner brackets
  $bx = [float]($size * 0.24); $bw = [float]($size * 0.52); $by = [float]($size * 0.27); $bh = [float]($size * 0.46)
  $bars = @(0.0, 0.14, 0.30, 0.44, 0.62, 0.78, 0.90)
  $widths = @(0.08, 0.06, 0.10, 0.05, 0.10, 0.05, 0.08)
  for ($i = 0; $i -lt $bars.Count; $i++) {
    $g.FillRectangle([Drawing.Brushes]::White, ($bx + $bw * $bars[$i]), $by, ($bw * $widths[$i]), $bh)
  }
  $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, 250, 204, 21)), ([float]([math]::Max(2, $size * 0.04)))
  $midY = [float]($size * 0.50)
  $g.DrawLine($pen, [float]($size * 0.18), $midY, [float]($size * 0.82), $midY)
  New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
  $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $g.Dispose(); $bmp.Dispose()
}
@{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }.GetEnumerator() | ForEach-Object { New-ScannerIcon $_.Value "$B\res\mipmap-$($_.Key)\ic_launcher.png" }

Step 'aapt2 compile / link'
Run (Join-Path $Bt 'aapt2.exe') compile --dir "$B\res" -o "$B\res.zip"
Run (Join-Path $Bt 'aapt2.exe') link -o "$B\base.apk" -I $AndroidJar --manifest (Join-Path $App 'AndroidManifest.xml') --java "$B\gen" `
  --version-code $VersionCode --version-name $Version --min-sdk-version 24 --target-sdk-version 36 "$B\res.zip"

Step 'javac'
$srcs = @(Get-ChildItem (Join-Path $App 'src'), "$B\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
Run (Join-Path $Jdk 'bin\javac.exe') -nowarn '-Xlint:-options' -encoding UTF-8 -source 8 -target 8 -bootclasspath "$AndroidJar;$(Join-Path $Bt 'core-lambda-stubs.jar')" -classpath $Zxing -d "$B\classes" @srcs

Step 'd8'
$classes = @(Get-ChildItem "$B\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
Run (Join-Path $Bt 'd8.bat') --release --min-api 24 --lib $AndroidJar --output "$B\dex" @classes $Zxing

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
  Step 'Creating release keystore'
  New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
  $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  Run (Join-Path $Jdk 'bin\keytool.exe') -genkeypair -keystore $Ks -alias xerp -keyalg RSA -keysize 3072 -validity 18250 -storepass $pw -keypass $pw -dname 'CN=x.erp, O=x.erp, C=CN'
  Set-Content -Path $KsProps -Value "storePassword=$pw" -Encoding ASCII
}
$pw = (@(Get-Content $KsProps | Where-Object { $_ -match '^storePassword=' })[0] -replace '^storePassword=', '').Trim()
$Apk = Join-Path $Dist "xerp-scanner-$Version-android.apk"
Step 'Signing'
Run (Join-Path $Bt 'apksigner.bat') sign --ks $Ks --ks-key-alias xerp --ks-pass "pass:$pw" --key-pass "pass:$pw" --out $Apk "$B\aligned.apk"
Run (Join-Path $Bt 'apksigner.bat') verify $Apk
Step ("Done: $Apk ({0:N1} MB)" -f ((Get-Item $Apk).Length / 1MB))
