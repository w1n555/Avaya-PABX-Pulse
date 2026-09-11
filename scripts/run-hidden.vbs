' Start python.exe with a hidden window (style 0). Do not use pythonw.exe:
' pythonw can listen on 18776 but return empty HTTP.
' Args: pythonExe script host port dataDir [pythonPath]
If WScript.Arguments.Count < 5 Then WScript.Quit 1
Dim sh, py, script, host, port, data, pypath, cmd
Set sh = CreateObject("WScript.Shell")
py = WScript.Arguments(0)
script = WScript.Arguments(1)
host = WScript.Arguments(2)
port = WScript.Arguments(3)
data = WScript.Arguments(4)
If WScript.Arguments.Count >= 6 Then
  sh.Environment("Process")("PYTHONPATH") = WScript.Arguments(5)
End If
sh.Environment("Process")("PYTHONUNBUFFERED") = "1"
cmd = """" & py & """ """ & script & """ --host " & host & " --port " & port & " --data-dir """ & data & """"
sh.Run cmd, 0, False
