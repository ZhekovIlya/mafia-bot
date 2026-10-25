@echo off
rem Makes the bot start hidden every time you log in to Windows, and starts it now.
rem To undo: run uninstall-autostart.bat
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
echo CreateObject("WScript.Shell").Run "wscript ""%~dp0run-hidden.vbs""", 0, False> "%STARTUP%\mafia-bot.vbs"
wscript "%~dp0run-hidden.vbs"
echo Autostart installed. The bot now runs in the background whenever you're logged in.
echo To stop it: stop-bot.bat   To remove autostart: uninstall-autostart.bat
pause
