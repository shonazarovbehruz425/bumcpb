@echo off
REM Register this MCP server with your AI client (Claude Desktop).
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
node scripts\register-mcp.mjs
popd
endlocal
