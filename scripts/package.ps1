param([string]$OutputFile)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'package-source.ps1') @PSBoundParameters
