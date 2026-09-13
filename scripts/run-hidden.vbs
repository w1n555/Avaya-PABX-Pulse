' Start python.exe with a hidden window (style 0). Do not use pythonw.exe:
' pythonw can listen on 18776 but return empty HTTP.
' Args: pythonExe script host port dataDir [pythonPath]
' All paths must exist (absolute preferred) — avoids WSH 80070002 on first install.
' No MsgBox: headless NOC / scheduled-task safe.
On Error Resume Next
If WScript.Arguments.Count < 5 Then WScript.Quit 1

Dim fso, sh, py, script, host, port, data, pypath, cmd, work
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

py = WScript.Arguments(0)
script = WScript.Arguments(1)
host = WScript.Arguments(2)
port = WScript.Arguments(3)
data = WScript.Arguments(4)

' Absolute paths (resolves relative to current directory)
If py <> "" Then py = fso.GetAbsolutePathName(py)
If script <> "" Then script = fso.GetAbsolutePathName(script)
If data <> "" Then data = fso.GetAbsolutePathName(data)

If Not fso.FileExists(py) Then WScript.Quit 2
If Not fso.FileExists(script) Then WScript.Quit 3
If data = "" Then WScript.Quit 4
If Not fso.FolderExists(data) Then
  fso.CreateFolder data
  If Not fso.FolderExists(data) Then WScript.Quit 4
End If

If WScript.Arguments.Count >= 6 Then
  pypath = WScript.Arguments(5)
  If pypath <> "" Then
    pypath = fso.GetAbsolutePathName(pypath)
    sh.Environment("Process")("PYTHONPATH") = pypath
  End If
End If
sh.Environment("Process")("PYTHONUNBUFFERED") = "1"

work = fso.GetParentFolderName(script)
If work <> "" Then sh.CurrentDirectory = work

cmd = """" & py & """ """ & script & """ --host " & host & " --port " & port & " --data-dir """ & data & """"
Err.Clear
sh.Run cmd, 0, False
If Err.Number <> 0 Then WScript.Quit 5
WScript.Quit 0
