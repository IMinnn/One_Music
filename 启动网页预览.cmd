@echo off
cd /d "%~dp0harmony"
call npm run preview:background
if errorlevel 1 pause
