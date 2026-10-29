@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
    echo Failed to switch to the project directory.
    pause
    exit /b 1
)

set "NODE_USE_SYSTEM_CA=1"

echo ================================================
echo GitHub Copilot API Server with Usage Viewer
echo ================================================
echo.

where bun >nul 2>&1
if errorlevel 1 (
    echo Bun was not found. Install Bun and make sure it is available in PATH.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    bun install
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
    echo.
)

echo Starting server...
echo The usage viewer page will open automatically after the server starts
echo.

start "" "https://ericc-ch.github.io/copilot-api?endpoint=http://localhost:4141/usage"
bun run ./src/main.ts start --port 4141
set "SERVER_EXIT_CODE=%ERRORLEVEL%"

if not "%SERVER_EXIT_CODE%"=="0" (
    echo.
    echo The server exited with code %SERVER_EXIT_CODE%.
)

pause
exit /b %SERVER_EXIT_CODE%
