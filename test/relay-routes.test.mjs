import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Windows proxy exceptions reconcile removed targets and rollback preserves preexisting user entries',{skip:process.platform!=='win32',timeout:10000},t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-relay-routes-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const script=String.raw`
param([string]$TestRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts\TrafficWatch-RelayRoutes.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'route script parser rejected'}
foreach($name in @('Set-RelayNoProxy','Test-RelayIp')){
  $definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  Invoke-Expression $definition.Extent.Text
}
$relayEnvPath='mock:user-env'
$relayEnvFile=Join-Path $TestRoot 'ownership.json'
$script:environmentValue='localhost,old.example.test,preexisting.example.test'
$script:environmentExists=$true
function Test-Path {param([string]$LiteralPath)if($LiteralPath -eq $relayEnvPath){return $true};return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath}
function Get-ItemProperty {param($LiteralPath,$Name,$ErrorAction)if($script:environmentExists){return [pscustomobject]@{NO_PROXY=$script:environmentValue}}}
function Set-ItemProperty {param($LiteralPath,$Name,$Value,$Type)$script:environmentValue=$Value;$script:environmentExists=$true}
function Remove-ItemProperty {param($LiteralPath,$Name,$ErrorAction)$script:environmentValue='';$script:environmentExists=$false}
[IO.File]::WriteAllText($relayEnvFile,'{"added":["old.example.test"],"existed":true}')
$null=Set-RelayNoProxy $false @('new.example.test','preexisting.example.test')
if($script:environmentValue -ne 'localhost,preexisting.example.test,new.example.test'){throw 'exception reconciliation changed user entries'}
$ownership=Get-Content -LiteralPath $relayEnvFile -Raw|ConvertFrom-Json
if(@($ownership.added).Count -ne 1 -or $ownership.added[0] -ne 'new.example.test'){throw 'incorrect exception ownership'}
$null=Set-RelayNoProxy $false @('new.example.test','preexisting.example.test')
if($script:environmentValue -ne 'localhost,preexisting.example.test,new.example.test'){throw 'repeated reconciliation duplicated entries'}
$null=Set-RelayNoProxy $true @()
if($script:environmentValue -ne 'localhost,preexisting.example.test'){throw 'rollback removed user entries'}
if(-not(Test-RelayIp '93.184.216.34')){throw 'valid address rejected'}
foreach($invalid in @('10.0.0.1','172.31.0.1','192.168.1.1','100.64.0.1','198.18.0.1','203.0.113.1','224.0.0.1')){if(Test-RelayIp $invalid){throw 'reserved route target accepted'}}
Write-Output 'relay-exception-ownership-passed'
`;
  const file=path.join(dir,'check.ps1');fs.writeFileSync(file,'\uFEFF'+script);
  const output=execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-TestRoot',dir],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',windowsHide:true,timeout:8000});
  assert.match(output,/relay-exception-ownership-passed/);
});
