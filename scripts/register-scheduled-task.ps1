<#
.SYNOPSIS
  Registers a Windows Task Scheduler task that runs "notesync sync" periodically.

.EXAMPLE
  .\scripts\register-scheduled-task.ps1 -IntervalMinutes 15
  .\scripts\register-scheduled-task.ps1 -IntervalMinutes 10 -Hidden
  Unregister-ScheduledTask -TaskName notesync -Confirm:$false   # remove it again
#>
param(
  [string]$TaskName = "notesync",
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  # Run without a console window (uses conhost --headless, Windows 10 1809+ / 11).
  [switch]$Hidden
)

$ErrorActionPreference = "Stop"
$node = (Get-Command node).Source
$cli = Join-Path $ProjectDir "dist\cli\index.js"
if (-not (Test-Path $cli)) { throw "Build the project first: npm run build  (missing $cli)" }

$arguments = "`"$cli`" sync --quiet"
if ($Hidden) {
  $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$node`" $arguments" -WorkingDirectory $ProjectDir
} else {
  $action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $ProjectDir
}

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# IgnoreNew: never start a second copy while one is still running
# (notesync's own lock file is a second line of defence).
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# Runs as the current user, only while logged on, so Windows Credential Manager
# (where the Google token lives) is available.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "Simplenote -> DOCX -> Google Drive sync (notesync)" -Force | Out-Null

Write-Host "Registered task '$TaskName' (every $IntervalMinutes min)."
Write-Host "Run now:    Start-ScheduledTask -TaskName $TaskName"
Write-Host "Last result: (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult   # 0 = success"
