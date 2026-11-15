import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('PktMon memory ownership requires every private nonce filter, safe path and exact metadata mode',{skip:process.platform!=='win32'},()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const script=String.raw`
$ErrorActionPreference='Stop'
$sourceFile=Join-Path (Get-Location) 'scripts\TrafficWatch-PktMon.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourceFile,[ref]$tokens,[ref]$errors)
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-PktOwned'},$true)
Invoke-Expression $definition.Extent.Text
$pktDir=Join-Path (Get-Location) '.build\synthetic-private'
$pktExe='Invoke-SyntheticPktMon'
$owner=[pscustomobject]@{file=(Join-Path $pktDir '0123456789abcdef0123456789abcdef.etl');filters=@('TrafficWatch-a1b2c3d4-0','TrafficWatch-a1b2c3d4-1');from=1}
$script:syntheticStatus=''
function Invoke-SyntheticPktMon {$global:LASTEXITCODE=0;return $script:syntheticStatus}
$base=@('1 TrafficWatch-a1b2c3d4-0 TCP 192.0.2.1 443','2 TrafficWatch-a1b2c3d4-1 TCP 192.0.2.2 443','Microsoft-Windows-PktMon 4 0x2','8 MB') -join [Environment]::NewLine
$script:syntheticStatus=$base
if(-not(Test-PktOwned $owner)){throw 'owned memory session rejected'}
$script:syntheticStatus=$base+[Environment]::NewLine+'3 SomeoneElse TCP 192.0.2.3 443'
if(Test-PktOwned $owner){throw 'foreign filter accepted'}
$script:syntheticStatus=$base.Replace('0x2','0x12')
if(Test-PktOwned $owner){throw 'raw packet mode accepted'}
$script:syntheticStatus=$base.Replace('8 MB','16 MB')
if(Test-PktOwned $owner){throw 'unknown buffer accepted'}
$script:syntheticStatus=$base.Replace('TrafficWatch-a1b2c3d4-1','TrafficWatch-deadbeef-1')
if(Test-PktOwned $owner){throw 'foreign nonce accepted'}
$script:syntheticStatus=$base
$owner.file=Join-Path (Get-Location) 'outside.etl'
if(Test-PktOwned $owner){throw 'outside owner path accepted'}
Write-Output 'ownership-boundaries-passed'
`;
  const result=execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});assert.match(result,/ownership-boundaries-passed/);
});
test('PktMon memory export stays in a fresh private directory when Windows ignores the start filename',{skip:process.platform!=='win32'},()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const script=String.raw`
$ErrorActionPreference='Stop'
$sourceFile=Join-Path (Get-Location) 'scripts\TrafficWatch-PktMon.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourceFile,[ref]$tokens,[ref]$errors)
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-PktOwned'},$true)
Invoke-Expression $definition.Extent.Text
$pktTestRoot=[IO.Path]::GetFullPath((Join-Path (Get-Location) '.build'))
[IO.Directory]::CreateDirectory($pktTestRoot)|Out-Null
$pktDir=Join-Path $pktTestRoot ('pktmon-export-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($pktDir)|Out-Null
$pktExe='Invoke-SyntheticPktMon'
$owner=[pscustomobject]@{file=(Join-Path $pktDir '0123456789abcdef0123456789abcdef.etl')}
$originalLocation=(Get-Location).Path
function Invoke-SyntheticPktMon {
  if((Split-Path -Parent (Get-Location).Path) -ne $pktDir){throw 'unsafe native working directory'}
  if((Split-Path -Leaf (Get-Location).Path) -notmatch '^export-[a-f0-9]{32}$'){throw 'non-unique export directory'}
  [IO.File]::WriteAllBytes((Join-Path (Get-Location).Path 'PktMon.etl'),[byte[]]@(1,2,3))
  $global:LASTEXITCODE=0
}
try{
  $saved=Stop-PktOwned $owner
  if($saved -ne $owner.file -or (Get-Item -LiteralPath $saved).Length -ne 3){throw 'memory export not relocated'}
  if((Get-Location).Path -ne $originalLocation){throw 'working directory not restored'}
  if(@(Get-ChildItem -LiteralPath $pktDir -Force).Count -ne 1){throw 'temporary export directory leaked'}
  $collisionRejected=$false;try{Stop-PktOwned $owner}catch{$collisionRejected=$_.Exception.Message -eq 'pktmon_export_collision'}
  if(-not $collisionRejected){throw 'existing export overwritten'}
  $owner.file=Join-Path $pktTestRoot 'outside.etl'
  $outsideRejected=$false;try{Stop-PktOwned $owner}catch{$outsideRejected=$_.Exception.Message -eq 'invalid_pktmon_export_path'}
  if(-not $outsideRejected){throw 'outside export path accepted'}
  Write-Output 'private-export-passed'
}finally{
  if([IO.Path]::GetFullPath($pktDir).StartsWith($pktTestRoot+'\',[StringComparison]::OrdinalIgnoreCase)){
    foreach($temporary in @(Get-ChildItem -LiteralPath $pktDir -Force)){if(-not $temporary.PSIsContainer){Remove-Item -LiteralPath $temporary.FullName -Force}}
    if(-not @(Get-ChildItem -LiteralPath $pktDir -Force).Count){Remove-Item -LiteralPath $pktDir -Force}
  }
}
`;
  const result=execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});assert.match(result,/private-export-passed/);
});
