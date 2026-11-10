# =====================================================================
#  SAPTCO dashboard - Excel auto sync (Windows, no installs needed)
#  Watches the Excel file and uploads it to the dashboard server every
#  time it is saved, so everyone who opens the link sees the update.
#
#  Usage:
#    start-sync.bat          run now (first run asks you to pick the Excel file)
#    install-autostart.bat   run in background + start with Windows
#    uninstall-autostart.bat stop starting with Windows
#    change-file.bat         pick a different Excel file
# =====================================================================
param([switch]$Pick, [switch]$Install, [switch]$Uninstall)

$ServerUrl  = 'https://saptcoreport-production.up.railway.app/api/dashboard-data'
$IntervalSec = 3

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Here 'excel-sync-config.json'
$LogPath    = Join-Path $Here 'excel-sync.log'
$LinkPath   = Join-Path ([Environment]::GetFolderPath('Startup')) 'SAPTCO Excel Sync.lnk'
$PsExe      = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-Log([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try {
        if ((Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -gt 1MB)) {
            Remove-Item -LiteralPath $LogPath -Force
        }
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch {}
}

function Select-ExcelFile {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title  = 'SAPTCO - choose the dashboard Excel file'
    $dlg.Filter = 'Excel (*.xlsx;*.xlsm)|*.xlsx;*.xlsm'
    $ok = $dlg.ShowDialog($owner)
    $owner.Dispose()
    if ($ok -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.FileName }
    return $null
}

function Get-ExcelPath([bool]$forcePick) {
    $file = $null
    if (-not $forcePick -and (Test-Path -LiteralPath $ConfigPath)) {
        try { $file = (Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).file } catch {}
    }
    if (-not $file -or -not (Test-Path -LiteralPath $file)) {
        $file = Select-ExcelFile
        if (-not $file) { return $null }
        @{ file = $file } | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
    }
    return $file
}

# ---------- autostart install / uninstall ----------
if ($Uninstall) {
    if (Test-Path -LiteralPath $LinkPath) { Remove-Item -LiteralPath $LinkPath -Force }
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*excel-sync.ps1*' -and $_.ProcessId -ne $PID } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host 'Autostart removed and sync stopped.'
    exit 0
}

if ($Install) {
    if (-not (Get-ExcelPath $false)) { Write-Host 'No file chosen.'; exit 1 }
    $ws  = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($LinkPath)
    $lnk.TargetPath  = $PsExe
    $lnk.Arguments   = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '"'
    $lnk.WorkingDirectory = $Here
    $lnk.WindowStyle = 7
    $lnk.Save()
    Start-Process -FilePath $PsExe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $ScriptPath + '"'))
    Write-Host 'Done: sync is running in the background and will start with Windows.'
    exit 0
}

# ---------- single instance ----------
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\SaptcoExcelSync', [ref]$created)
if (-not $created) {
    if ($Pick) { [void](Get-ExcelPath $true); Write-Host 'File changed. Restart the sync (or the computer) to use it.' }
    else { Write-Host 'Sync is already running.' }
    exit 0
}

$File = Get-ExcelPath ([bool]$Pick)
if (-not $File) { Write-Log 'No Excel file chosen - exiting.'; exit 1 }
Write-Log ('Watching: ' + $File)
Write-Log ('Server:   ' + $ServerUrl)

function Read-SharedBytes([string]$path) {
    # opens the file even while Excel has it open
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
        $ms = New-Object System.IO.MemoryStream
        $fs.CopyTo($ms)
        return ,$ms.ToArray()
    } finally { $fs.Dispose() }
}

function Send-Excel([byte[]]$bytes, [string]$name) {
    $headers = @{ 'x-file-name' = [Uri]::EscapeDataString($name) }
    Invoke-WebRequest -Uri $ServerUrl -Method Post -Body $bytes -ContentType 'application/octet-stream' `
        -Headers $headers -UseBasicParsing -TimeoutSec 60 | Out-Null
}

$lastSent = $null   # "ticks|size" of the last uploaded version
$seen     = $null   # wait one cycle so Excel finishes writing
$lastErr  = ''

while ($true) {
    try {
        if (Test-Path -LiteralPath $File) {
            $info  = Get-Item -LiteralPath $File
            $stamp = '{0}|{1}' -f $info.LastWriteTimeUtc.Ticks, $info.Length
            if ($stamp -ne $lastSent) {
                if ($stamp -ne $seen) {
                    $seen = $stamp
                } else {
                    $bytes = Read-SharedBytes $File
                    if ($bytes.Length -gt 1000 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B) {
                        Send-Excel $bytes $info.Name
                        $lastSent = $stamp
                        $lastErr = ''
                        Write-Log ('Uploaded (' + [math]::Round($bytes.Length / 1KB) + ' KB) - dashboard updated for everyone')
                    }
                }
            }
        }
    } catch {
        $m = $_.Exception.Message
        if ($m -ne $lastErr) { Write-Log ('Will retry: ' + $m); $lastErr = $m }
    }
    Start-Sleep -Seconds $IntervalSec
}
