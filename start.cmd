@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node server.js
  exit /b
)
if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe" (
  "%ProgramFiles%\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe" server.js
  exit /b
)
echo Node.js 20+ is required. Install Node.js and run this file again.
exit /b 1
