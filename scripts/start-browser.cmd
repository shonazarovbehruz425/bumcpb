@echo off
REM Start Chrome with the configured Google profile and CDP debugging.
REM Run this BEFORE the MCP server. Reads values from config\flow.config.json.
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "PROJECT_DIR=%CD%"

REM Read config values via Node (chromePath, chromeUserDataDir, chromeProfile, cdpPort).
for /f "usebackq delims=" %%C in (`node -e "const c=require('./config/flow.config.json');process.stdout.write(c.chromePath||'')"`) do set "CHROME=%%C"
for /f "usebackq delims=" %%U in (`node -e "const c=require('./config/flow.config.json');process.stdout.write(c.chromeUserDataDir||'')"`) do set "USER_DATA_DIR=%%U"
for /f "usebackq delims=" %%P in (`node -e "const c=require('./config/flow.config.json');process.stdout.write(c.chromeProfile||'Default')"`) do set "PROFILE=%%P"
for /f "usebackq delims=" %%D in (`node -e "const c=require('./config/flow.config.json');process.stdout.write(String(c.cdpPort||9222))"`) do set "CDP_PORT=%%D"

if "%CHROME%"=="" (
  if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
)
if "%CHROME%"=="" (
  if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
)
if "%CHROME%"=="" (
  if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "%CHROME%"=="" (
  echo [ERROR] Chrome executable not found. Set "chromePath" in config\flow.config.json.
  popd
  exit /b 1
)
if not exist "%CHROME%" (
  echo [ERROR] Chrome not found at %CHROME%
  popd
  exit /b 1
)

echo [INFO] Launching Chrome profile "%PROFILE%" on CDP port %CDP_PORT%
start "" "%CHROME%" ^
  --user-data-dir="%USER_DATA_DIR%" ^
  --profile-directory="%PROFILE%" ^
  --remote-debugging-port=%CDP_PORT% ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-blink-features=AutomationControlled ^
  --disable-extensions ^
  --disable-sync ^
  --disable-background-networking ^
  --disable-component-update

echo [INFO] Chrome launch requested. Give it a few seconds to open CDP on port %CDP_PORT%.
popd
endlocal
