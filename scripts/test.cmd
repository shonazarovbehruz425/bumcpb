@echo off
REM Run the end-to-end integration test (launches Chrome).
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is required but was not found on PATH.
  popd
  exit /b 1
)

node scripts\test-e2e.mjs

popd
endlocal
