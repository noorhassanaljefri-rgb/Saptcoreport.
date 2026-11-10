@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0excel-sync.ps1" -Pick
pause
