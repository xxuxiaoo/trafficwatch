param([string]$OutputFile,[string]$DependencyRoot)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'build-windows.ps1') @PSBoundParameters
