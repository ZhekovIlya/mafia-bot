@echo off
rem One-click launcher: asks for the bot token on first run, builds, and runs the bot.
rem If the bot ever crashes it restarts automatically. Close this window to stop it.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed. Download it from https://nodejs.org and run this again.
    pause
    exit /b 1
)

if not exist .env (
    echo First run setup - get these from @BotFather in Telegram.
    set /p TOKEN=Paste BOT_TOKEN:
    set /p UNAME=Bot username without @:
    call :writeenv
)

if not exist node_modules call npm ci
call npm run build || (pause & exit /b 1)

:loop
echo Starting Mafia Bot... (close this window to stop)
node dist\mafia-bot.js
echo Bot stopped, restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop

:writeenv
setlocal enabledelayedexpansion
(
    echo BOT_TOKEN=!TOKEN!
    echo BOT_USERNAME=!UNAME!
) > .env
endlocal
exit /b
