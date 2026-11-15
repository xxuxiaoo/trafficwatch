@echo off
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0src\vault-ai.mjs" %*
