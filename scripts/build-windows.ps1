param([string]$OutputFile,[string]$DependencyRoot)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$projectVersion=(Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw|ConvertFrom-Json).version
$buildRoot=Join-Path $projectRoot '.build'
$stageRoot=[IO.Path]::GetFullPath((Join-Path $buildRoot 'windows'))
$stage=Join-Path $stageRoot 'TrafficWatch'
$cache=Join-Path $buildRoot 'dependencies'
if(-not $OutputFile){$OutputFile=Join-Path $buildRoot 'trafficwatch-windows-x64.zip'}
$OutputFile=[IO.Path]::GetFullPath($OutputFile)
if($OutputFile.StartsWith($stageRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The output archive must be outside the staging directory.'}
$nodeVersion='24.22.1'
$nodeArchiveSha='d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
$nodeExeSha='d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'
$webviewVersion='1.0.4258.31'
$webviewSha='56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'
$nodeBase="https://nodejs.org/dist/v$nodeVersion"
$webviewUrl="https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webviewVersion/microsoft.web.webview2.$webviewVersion.nupkg"
$sdkFiles=@{
  'Microsoft.Web.WebView2.Core.dll'='d60e6e94245078cb56e44ebd5f360dc04bf18e460136be93bfc4cfca43b98505';
  'Microsoft.Web.WebView2.WinForms.dll'='6a9e6856f23c463783c3afb0ca5d78f56324c86657162ccb16d5227b3233b32a';
  'WebView2Loader.dll'='3426dcc55fdfb8b5e7ac623cf33b4ccf283fbf68a0c5a65bddfdb4d749a8abee'
}
function Assert-BuildHash([string]$File,[string]$Expected){
  if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected){throw ('Pinned dependency hash mismatch: '+[IO.Path]::GetFileName($File))}
}
function Get-BuildDownload([string]$Url,[string]$Destination){
  & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 --retry 2 --output $Destination $Url
  if($LASTEXITCODE -ne 0){throw ('Dependency download failed: '+$Url)}
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Expand-BuildEntries([string]$Archive,[hashtable]$Entries){
  $zip=[IO.Compression.ZipFile]::OpenRead($Archive)
  try{
    foreach($name in $Entries.Keys){
      $entry=$zip.GetEntry($name)
      if(-not $entry){throw ('Missing dependency entry: '+$name)}
      [IO.Directory]::CreateDirectory((Split-Path -Parent $Entries[$name]))|Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$Entries[$name],$true)
    }
  }finally{$zip.Dispose()}
}
if($stageRoot -ne [IO.Path]::GetFullPath((Join-Path $projectRoot '.build\windows'))){throw 'Unsafe build staging path.'}
if(Test-Path -LiteralPath $stageRoot){Remove-Item -LiteralPath $stageRoot -Recurse -Force}
[IO.Directory]::CreateDirectory($stage)|Out-Null
[IO.Directory]::CreateDirectory($cache)|Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stage 'runtime'))|Out-Null
if($DependencyRoot){
  $DependencyRoot=[IO.Path]::GetFullPath($DependencyRoot)
  Assert-BuildHash (Join-Path $DependencyRoot 'runtime\node.exe') $nodeExeSha
  foreach($name in $sdkFiles.Keys){Assert-BuildHash (Join-Path $DependencyRoot $name) $sdkFiles[$name]}
  foreach($name in @('node.exe','NODE-LICENSE.txt','SHASUMS256.txt')){Copy-Item -LiteralPath (Join-Path $DependencyRoot ('runtime\'+$name)) -Destination (Join-Path $stage ('runtime\'+$name))}
  foreach($name in @($sdkFiles.Keys)+@('WEBVIEW2-LICENSE.txt','WEBVIEW2-NOTICE.txt')){Copy-Item -LiteralPath (Join-Path $DependencyRoot $name) -Destination (Join-Path $stage $name)}
}else{
  $nodeArchive=Join-Path $cache "node-v$nodeVersion-win-x64.zip"
  $sums=Join-Path $cache "node-v$nodeVersion-SHASUMS256.txt"
  Get-BuildDownload "$nodeBase/SHASUMS256.txt" $sums
  $nodeLines=[IO.File]::ReadAllText($sums)
  if($nodeLines -notmatch ($nodeArchiveSha+'\s+node-v'+[regex]::Escape($nodeVersion)+'-win-x64\.zip') -or $nodeLines -notmatch ($nodeExeSha+'\s+win-x64/node\.exe')){throw 'Official Node.js checksums do not match the pinned release.'}
  if(-not(Test-Path -LiteralPath $nodeArchive)){Get-BuildDownload "$nodeBase/node-v$nodeVersion-win-x64.zip" $nodeArchive}
  Assert-BuildHash $nodeArchive $nodeArchiveSha
  Expand-BuildEntries $nodeArchive @{
    "node-v$nodeVersion-win-x64/node.exe"=(Join-Path $stage 'runtime\node.exe');
    "node-v$nodeVersion-win-x64/LICENSE"=(Join-Path $stage 'runtime\NODE-LICENSE.txt')
  }
  Copy-Item -LiteralPath $sums -Destination (Join-Path $stage 'runtime\SHASUMS256.txt')
  $webviewArchive=Join-Path $cache "webview2-$webviewVersion.nupkg"
  if(-not(Test-Path -LiteralPath $webviewArchive)){Get-BuildDownload $webviewUrl $webviewArchive}
  Assert-BuildHash $webviewArchive $webviewSha
  Expand-BuildEntries $webviewArchive @{
    'lib/net462/Microsoft.Web.WebView2.Core.dll'=(Join-Path $stage 'Microsoft.Web.WebView2.Core.dll');
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll'=(Join-Path $stage 'Microsoft.Web.WebView2.WinForms.dll');
    'runtimes/win-x64/native/WebView2Loader.dll'=(Join-Path $stage 'WebView2Loader.dll');
    'LICENSE.txt'=(Join-Path $stage 'WEBVIEW2-LICENSE.txt');
    'NOTICE.txt'=(Join-Path $stage 'WEBVIEW2-NOTICE.txt')
  }
}
Assert-BuildHash (Join-Path $stage 'runtime\node.exe') $nodeExeSha
foreach($name in $sdkFiles.Keys){Assert-BuildHash (Join-Path $stage $name) $sdkFiles[$name]}
@{version=$nodeVersion;archiveSha256=$nodeArchiveSha;executableSha256=$nodeExeSha;downloadUrl="$nodeBase/node-v$nodeVersion-win-x64.zip";license='NODE-LICENSE.txt'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'runtime\runtime-manifest.json') -Encoding UTF8
@{sdkVersion=$webviewVersion;packageSha256=$webviewSha;packageUrl=$webviewUrl;runtime='Microsoft Edge WebView2 Evergreen (installed separately)'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'webview2-manifest.json') -Encoding UTF8
# Explicit source allowlist. Personal configuration and records never enter the stage.
foreach($name in @('src','public','docs','desktop','native','LICENSE','NOTICE.md','THIRD_PARTY_NOTICES.md','README.md','README.en.md','README.zh-CN.md','SECURITY.md','CHANGELOG.md','package.json','config.example.json','TrafficWatch-Supervisor.ps1')){
  if($name -eq 'native'){
    [IO.Directory]::CreateDirectory((Join-Path $stage 'native'))|Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'native\NetworkCapture.cs') -Destination (Join-Path $stage 'native')
  }else{Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $stage -Recurse}
}
[IO.Directory]::CreateDirectory((Join-Path $stage 'scripts'))|Out-Null
foreach($name in @('build-native.ps1','windows-observer.ps1','TrafficWatch-Control.ps1','install-windows.ps1')){Copy-Item -LiteralPath (Join-Path $projectRoot ('scripts\'+$name)) -Destination (Join-Path $stage 'scripts')}
# Windows PowerShell 5.1 needs a BOM for Chinese source strings.
foreach($name in @('TrafficWatch-Control.ps1','install-windows.ps1')){
  $scriptPath=Join-Path $stage ('scripts\'+$name)
  [IO.File]::WriteAllText($scriptPath,[IO.File]::ReadAllText($scriptPath,[Text.Encoding]::UTF8),[Text.UTF8Encoding]::new($true))
}
& (Join-Path $projectRoot 'scripts\build-native.ps1') -Destination (Join-Path $stage 'native\Codex-Netwatch-Capture.exe')
if($LASTEXITCODE -ne 0){throw 'Native capture compilation failed.'}
$icon=Join-Path $stageRoot 'Netwatch.ico'
& (Join-Path $projectRoot 'desktop\make-icon.ps1') -Destination $icon
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$common=@('/nologo','/optimize+','/target:winexe','/platform:x64','/codepage:65001','/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',('/win32manifest:'+(Join-Path $projectRoot 'desktop\app.manifest')),('/win32icon:'+$icon))
$trayArgs=$common+@('/reference:'+(Join-Path $stage 'Microsoft.Web.WebView2.Core.dll'))+@('/reference:'+(Join-Path $stage 'Microsoft.Web.WebView2.WinForms.dll'))+@('/resource:'+$icon+',Netwatch.ico')+@('/out:'+(Join-Path $stage 'TrafficWatch-Tray.exe'))
$traySources=@('NetwatchTray.cs','DashboardWindow.cs','StartupRegistration.cs','MiniWindow.cs')|ForEach-Object {Join-Path $projectRoot ('desktop\'+$_)}
& $compiler @trayArgs @traySources
if($LASTEXITCODE -ne 0){throw 'Tray compilation failed.'}
$controlArgs=$common+@('/reference:Microsoft.CSharp.dll',('/out:'+(Join-Path $stage 'TrafficWatch-Control.exe')),(Join-Path $projectRoot 'desktop\TrafficWatch-Control.cs'))
& $compiler @controlArgs
if($LASTEXITCODE -ne 0){throw 'Controller compilation failed.'}
Copy-Item -LiteralPath (Join-Path $stage 'TrafficWatch-Tray.exe') -Destination (Join-Path $stage 'Codex-Netwatch.exe')
$exeConfig='<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>'
foreach($name in @('TrafficWatch-Tray.exe','TrafficWatch-Control.exe','Codex-Netwatch.exe')){[IO.File]::WriteAllText((Join-Path $stage ($name+'.config')),$exeConfig,[Text.UTF8Encoding]::new($false))}
$files=@(Get-ChildItem -LiteralPath $stage -File -Recurse|ForEach-Object {@{path=$_.FullName.Substring($stage.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
@{version=$projectVersion;files=$files}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Encoding UTF8
[IO.Directory]::CreateDirectory((Split-Path -Parent $OutputFile))|Out-Null
$pending=$OutputFile+'.pending'
if(Test-Path -LiteralPath $pending){Remove-Item -LiteralPath $pending -Force}
[IO.Compression.ZipFile]::CreateFromDirectory($stageRoot,$pending,[IO.Compression.CompressionLevel]::Optimal,$false)
Move-Item -LiteralPath $pending -Destination $OutputFile -Force
$archiveHash=(Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $OutputFile) 'SHA256SUMS.txt'),($archiveHash+'  '+[IO.Path]::GetFileName($OutputFile)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
Write-Host ('Build directory: '+$stage)
Write-Host ('Archive: '+$OutputFile)
Write-Host ('SHA256: '+$archiveHash)
