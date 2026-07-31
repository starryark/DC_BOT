$services = @(
    @{ Name = "Qwen3-ASR"; Port = 8765 },
    @{ Name = "GPT-SoVITS"; Port = 9880 }
)

$netstat = netstat -ano -p tcp
$rows = foreach ($service in $services) {
    $matches = $netstat | Select-String "^\s*TCP\s+\S+:$($service.Port)\s+\S+\s+LISTENING\s+(\d+)\s*$"
    if (-not $matches) {
        [pscustomobject]@{
            Service = $service.Name
            Port = $service.Port
            Status = "STOPPED"
            PID = ""
            Process = ""
            Path = ""
        }
        continue
    }

    foreach ($match in $matches) {
        $processId = [int]$match.Matches[0].Groups[1].Value
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        [pscustomobject]@{
            Service = $service.Name
            Port = $service.Port
            Status = "RUNNING"
            PID = $processId
            Process = $process.ProcessName
            Path = $process.Path
        }
    }
}

$rows | Format-Table -AutoSize
