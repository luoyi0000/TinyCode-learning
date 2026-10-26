# Run this in PowerShell from the TinyCode folder, then send the output back.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$log = Join-Path $env:TEMP "tinycode-startup.log"
Remove-Item $log -ErrorAction SilentlyContinue

Write-Host "1) ELECTRON_RUN_AS_NODE  = [" $env:ELECTRON_RUN_AS_NODE "]"
Write-Host "2) electron binary        = " (Test-Path ".\node_modules\electron\dist\electron.exe")
Write-Host "3) electron --version:"
& .\node_modules\electron\dist\electron.exe --version

Write-Host "4) launching the app for 8s ..."
$p = Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -PassThru
Start-Sleep -Seconds 8
if ($p.HasExited) { Write-Host ("   EXITED with code " + $p.ExitCode) } else { Write-Host "   STILL RUNNING (window should be visible)"; Stop-Process -Id $p.Id -Force }

Write-Host "5) startup log ($log):"
if (Test-Path $log) { Get-Content $log } else { Write-Host "   (no log file -- Electron died before any JS ran)" }
