@echo off
rem Stops the background bot (it starts again at next login).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'start-bot.bat|mafia-bot.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Mafia bot stopped.
pause
