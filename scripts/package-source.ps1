param([string]$OutputFile)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if(-not $OutputFile){$OutputFile=Join-Path $projectRoot '.build\trafficwatch-source.zip'}
$OutputFile=[IO.Path]::GetFullPath($OutputFile)
$stageRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot '.build\source-stage'))
if($OutputFile.StartsWith($stageRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Output must be outside source staging.'}
if($stageRoot -ne [IO.Path]::GetFullPath((Join-Path $projectRoot '.build\source-stage'))){throw 'Unsafe source staging path.'}
if(Test-Path -LiteralPath $stageRoot){Remove-Item -LiteralPath $stageRoot -Recurse -Force}
$stage=Join-Path $stageRoot 'trafficwatch'
[IO.Directory]::CreateDirectory($stage)|Out-Null
# git ls-files supplies exactly the reviewed tracked source tree, without local data.
$files=@(& git.exe -C $projectRoot ls-files)
if($LASTEXITCODE -ne 0 -or $files.Count -eq 0){throw 'Create a Git checkout and stage the reviewed source before packaging.'}
foreach($relative in $files){
  $source=[IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
  $target=[IO.Path]::GetFullPath((Join-Path $stage $relative))
  if(-not $source.StartsWith($projectRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $target.StartsWith($stage+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Source path escaped its workspace.'}
  [IO.Directory]::CreateDirectory((Split-Path -Parent $target))|Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}
[IO.Directory]::CreateDirectory((Split-Path -Parent $OutputFile))|Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
if(Test-Path -LiteralPath $OutputFile){Remove-Item -LiteralPath $OutputFile -Force}
[IO.Compression.ZipFile]::CreateFromDirectory($stageRoot,$OutputFile,[IO.Compression.CompressionLevel]::Optimal,$false)
Write-Host ('Source archive: '+$OutputFile)
