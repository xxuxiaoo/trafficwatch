param([string]$OutputFile,[string]$DependencyRoot,[string]$StageRoot)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$projectVersion=(Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw|ConvertFrom-Json).version
$buildRoot=Join-Path $projectRoot '.build'
$customStage=-not [string]::IsNullOrWhiteSpace($StageRoot)
$buildRootFull=[IO.Path]::GetFullPath($buildRoot)
if(-not $customStage){$stageRequest=Join-Path $buildRoot 'windows'}
elseif([IO.Path]::IsPathRooted($StageRoot)){$stageRequest=$StageRoot}
else{$stageRequest=Join-Path $projectRoot $StageRoot}
$stageRoot=[IO.Path]::GetFullPath($stageRequest)
$stage=Join-Path $stageRoot 'TrafficWatch'
$cache=Join-Path $buildRoot 'dependencies'
if(-not $OutputFile){$OutputFile=Join-Path $buildRoot 'trafficwatch-windows-x64.zip'}
$OutputFile=[IO.Path]::GetFullPath($OutputFile)
if(-not $stageRoot.StartsWith($buildRootFull+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Build staging must stay inside this checkout .build directory.'}
if($OutputFile.StartsWith($stageRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The output archive must be outside the staging directory.'}
$nodeVersion='24.22.1'
$nodeArchiveSha='d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
$nodeExeSha='d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'
$nodeBase="https://nodejs.org/dist/v$nodeVersion"
function Assert-BuildHash([string]$File,[string]$Expected){
  if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected){throw ('Pinned dependency hash mismatch: '+[IO.Path]::GetFileName($File))}
}
function Get-BuildDownload([string]$Url,[string]$Destination){
  & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 --retry 2 --output $Destination $Url
  if($LASTEXITCODE -ne 0){throw ('Dependency download failed: '+$Url)}
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
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
if($customStage -and (Test-Path -LiteralPath $stageRoot)){throw 'Custom staging directory already exists; choose a new empty path.'}
if(-not $customStage -and (Test-Path -LiteralPath $stageRoot)){Remove-Item -LiteralPath $stageRoot -Recurse -Force}
[IO.Directory]::CreateDirectory($stage)|Out-Null
[IO.Directory]::CreateDirectory($cache)|Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stage 'runtime'))|Out-Null
if($DependencyRoot){
  $DependencyRoot=[IO.Path]::GetFullPath($DependencyRoot)
  Assert-BuildHash (Join-Path $DependencyRoot 'runtime\node.exe') $nodeExeSha
  foreach($name in @('node.exe','NODE-LICENSE.txt','SHASUMS256.txt')){Copy-Item -LiteralPath (Join-Path $DependencyRoot ('runtime\'+$name)) -Destination (Join-Path $stage ('runtime\'+$name))}
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
}
Assert-BuildHash (Join-Path $stage 'runtime\node.exe') $nodeExeSha
@{version=$nodeVersion;archiveSha256=$nodeArchiveSha;executableSha256=$nodeExeSha;downloadUrl="$nodeBase/node-v$nodeVersion-win-x64.zip";license='NODE-LICENSE.txt'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'runtime\runtime-manifest.json') -Encoding UTF8
# Explicit source allowlist. Personal configuration and records never enter the stage.
foreach($name in @('src','public','migration','docs','desktop','native','LICENSE','NOTICE.md','THIRD_PARTY_NOTICES.md','README.md','README.en.md','README.zh-CN.md','SECURITY.md','CHANGELOG.md','package.json','package-lock.json','config.example.json','TrafficWatch-Supervisor.ps1')){
  if($name -eq 'native'){
    [IO.Directory]::CreateDirectory((Join-Path $stage 'native'))|Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'native\NetworkCapture.cs') -Destination (Join-Path $stage 'native')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'native\AiNetworkTrace.cs') -Destination (Join-Path $stage 'native')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'native\RelayProbe.cs') -Destination (Join-Path $stage 'native')
  }else{Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $stage -Recurse}
}
$cipherSource=Join-Path $projectRoot 'node_modules\better-sqlite3-multiple-ciphers'
if(-not(Test-Path -LiteralPath (Join-Path $cipherSource 'prebuilds\win32-x64.node'))){throw 'Run npm ci --ignore-scripts before building.'}
$cipherTarget=Join-Path $stage 'migration\node_modules\better-sqlite3-multiple-ciphers'
[IO.Directory]::CreateDirectory((Join-Path $cipherTarget 'prebuilds'))|Out-Null
foreach($name in @('lib','package.json','LICENSE')){Copy-Item -LiteralPath (Join-Path $cipherSource $name) -Destination $cipherTarget -Recurse}
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\node-addon-api\LICENSE.md') -Destination (Join-Path $cipherTarget 'NODE-ADDON-API-LICENSE.md')
Copy-Item -LiteralPath (Join-Path $cipherSource 'prebuilds\win32-x64.node') -Destination (Join-Path $cipherTarget 'prebuilds')
[IO.Directory]::CreateDirectory((Join-Path $stage 'node_modules'))|Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\yaml') -Destination (Join-Path $stage 'node_modules') -Recurse
[IO.Directory]::CreateDirectory((Join-Path $stage 'scripts'))|Out-Null
foreach($name in @('build-native.ps1','build-diagnostics.ps1','windows-observer.ps1','TrafficWatch-Control.ps1','TrafficWatch-RelayRoutes.ps1','TrafficWatch-PktMon.ps1','TrafficWatch-Resources.ps1','install-windows.ps1','upgrade-windows.ps1')){Copy-Item -LiteralPath (Join-Path $projectRoot ('scripts\'+$name)) -Destination (Join-Path $stage 'scripts')}
# Windows PowerShell 5.1 needs a BOM for Chinese source strings.
foreach($name in @('TrafficWatch-Control.ps1','TrafficWatch-RelayRoutes.ps1','TrafficWatch-PktMon.ps1','install-windows.ps1','upgrade-windows.ps1')){
  $scriptPath=Join-Path $stage ('scripts\'+$name)
  [IO.File]::WriteAllText($scriptPath,[IO.File]::ReadAllText($scriptPath,[Text.Encoding]::UTF8),[Text.UTF8Encoding]::new($true))
}
& (Join-Path $projectRoot 'scripts\build-native.ps1') -Destination (Join-Path $stage 'native\Codex-Netwatch-Capture.exe')
if($LASTEXITCODE -ne 0){throw 'Native capture compilation failed.'}
& (Join-Path $projectRoot 'scripts\build-diagnostics.ps1') -Destination (Join-Path $stage 'native')
$icon=Join-Path $stageRoot 'Netwatch.ico'
& (Join-Path $projectRoot 'desktop\make-icon.ps1') -Destination $icon
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$common=@('/nologo','/optimize+','/target:winexe','/platform:x64','/codepage:65001','/reference:System.dll','/reference:System.Core.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',('/win32manifest:'+(Join-Path $projectRoot 'desktop\app.manifest')),('/win32icon:'+$icon))
$trayArgs=$common+@('/resource:'+$icon+',Netwatch.ico')+@('/out:'+(Join-Path $stage 'TrafficWatch-Tray.exe'))
$traySources=@(Join-Path $projectRoot 'desktop\NetwatchTray.cs')
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
$zip=[IO.Compression.ZipFile]::Open($pending,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach($file in Get-ChildItem -LiteralPath $stageRoot -File -Recurse){
    $entryName=$file.FullName.Substring($stageRoot.Length+1).Replace('\','/')
    $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.FullName,$entryName,[IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zip.Dispose() }
Move-Item -LiteralPath $pending -Destination $OutputFile -Force
$archiveHash=(Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $OutputFile) 'SHA256SUMS.txt'),($archiveHash+'  '+[IO.Path]::GetFileName($OutputFile)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
Write-Host ('Build directory: '+$stage)
Write-Host ('Archive: '+$OutputFile)
Write-Host ('SHA256: '+$archiveHash)
