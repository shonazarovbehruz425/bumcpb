@echo off
REM Start the Google Flow Browser MCP server.
REM Chrome should already be running with CDP (scripts\start-browser.cmd),
REM otherwise the server will launch Chrome automatically.
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is required but was not found on PATH.
  popd
  exit /b 1
)

echo [INFO] Starting Google Flow Browser MCP server...
node src\index.js

popd
endlocal
