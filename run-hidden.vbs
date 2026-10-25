' Starts the bot hidden in the background (used by Windows Startup).
' If the bot isn't set up yet (.env missing), opens the launcher visibly to ask for the token.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' Don't start a second copy if the bot is already running.
Set procs = GetObject("winmgmts:").ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'")
For Each p In procs
    If Not IsNull(p.CommandLine) Then
        If InStr(p.CommandLine, "mafia-bot.js") > 0 Then WScript.Quit
    End If
Next

If fso.FileExists(dir & "\.env") Then
    ' Extra outer quotes: cmd /c strips one pair when the line has several quoted paths.
    sh.Run "cmd /c """"" & dir & "\start-bot.bat"" > """ & dir & "\bot.log"" 2>&1""", 0, False
Else
    sh.Run """" & dir & "\start-bot.bat""", 1, False
End If
