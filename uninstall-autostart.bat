@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\mafia-bot.vbs" 2>nul
call "%~dp0stop-bot.bat"
