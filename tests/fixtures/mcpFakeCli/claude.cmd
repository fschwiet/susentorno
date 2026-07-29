@echo off
setlocal
>> "%MCP_FAKE_LOG%" echo %~n0 %*
if /I "%1"=="mcp" if /I "%2"=="remove" exit /b %MCP_FAKE_REMOVE_EXIT%
if /I "%1"=="mcp" if /I "%2"=="add" exit /b %MCP_FAKE_ADD_EXIT%
exit /b 0
