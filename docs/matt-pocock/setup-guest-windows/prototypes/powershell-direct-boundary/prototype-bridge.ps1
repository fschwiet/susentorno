# THROWAWAY PROTOTYPE: evidence for the setup-guest-windows PowerShell Direct boundary.
# Requests arrive only on stdin as one JSON object. No credential or guest script is in argv.
param(
    [string] $VMName,
    [switch] $Local
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Invoke-ScriptProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Script,
        [Parameter(Mandatory = $true)][int] $TimeoutMs
    )

    $loader = @'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$ProgressPreference = 'SilentlyContinue'
[Console]::Error.Write('')
$encoded = [Console]::In.ReadToEnd()
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
& ([ScriptBlock]::Create($script))
'@
    $encodedLoader = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loader))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'powershell.exe'
    $start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedLoader"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Could not start the guest PowerShell process.' }

    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script)))
        $process.StandardInput.Close()

        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill()
            $process.WaitForExit()
            [pscustomobject]@{
                exitCode = 124
                stdout = $stdoutTask.Result
                stderr = $stderrTask.Result
                timedOut = $true
            }
            return
        }

        # The second wait ensures asynchronous output handlers have drained.
        $process.WaitForExit()
        [pscustomobject]@{
            exitCode = $process.ExitCode
            stdout = $stdoutTask.Result
            stderr = $stderrTask.Result
            timedOut = $false
        }
    }
    finally {
        $process.Dispose()
    }
}

try {
    $requestJson = [Console]::In.ReadToEnd()
    $request = $requestJson | ConvertFrom-Json
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.scriptBase64))
    $timeoutMs = [int]$request.timeoutMs

    if ($Local) {
        $result = Invoke-ScriptProcess -Script $script -TimeoutMs $timeoutMs
    }
    else {
        if ([string]::IsNullOrWhiteSpace($VMName)) { throw 'VMName is required unless -Local is used.' }

        # PowerShell 7 paths inherited by Windows PowerShell 5.1 can make the
        # Security module unloadable. This workaround is required before the
        # first ConvertTo-SecureString call.
        $env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;$env:PSModulePath"
        $secure = ConvertTo-SecureString ([string]$request.password) -AsPlainText -Force
        $credential = [Management.Automation.PSCredential]::new([string]$request.username, $secure)
        $request.password = $null

        # This is deliberately self-contained: local functions are not visible
        # in the PowerShell Direct runspace.
        $runner = {
            param([string] $GuestScript, [int] $GuestTimeoutMs)

            $loader = @'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$ProgressPreference = 'SilentlyContinue'
[Console]::Error.Write('')
$encoded = [Console]::In.ReadToEnd()
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
& ([ScriptBlock]::Create($script))
'@
            $encodedLoader = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loader))
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = 'powershell.exe'
            $start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedLoader"
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $start.StandardOutputEncoding = [Text.Encoding]::UTF8
            $start.StandardErrorEncoding = [Text.Encoding]::UTF8
            $process = [Diagnostics.Process]::new()
            $process.StartInfo = $start
            if (-not $process.Start()) { throw 'Could not start the guest PowerShell process.' }

            try {
                $stdoutTask = $process.StandardOutput.ReadToEndAsync()
                $stderrTask = $process.StandardError.ReadToEndAsync()
                $process.StandardInput.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($GuestScript)))
                $process.StandardInput.Close()
                if (-not $process.WaitForExit($GuestTimeoutMs)) {
                    $process.Kill()
                    $process.WaitForExit()
                    return [pscustomobject]@{
                        exitCode = 124
                        stdout = $stdoutTask.Result
                        stderr = $stderrTask.Result
                        timedOut = $true
                    }
                }
                $process.WaitForExit()
                return [pscustomobject]@{
                    exitCode = $process.ExitCode
                    stdout = $stdoutTask.Result
                    stderr = $stderrTask.Result
                    timedOut = $false
                }
            }
            finally {
                $process.Dispose()
            }
        }

        $result = Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock $runner -ArgumentList $script, $timeoutMs
    }

    [pscustomobject]@{
        exitCode = [int]$result.exitCode
        stdout = [string]$result.stdout
        stderr = [string]$result.stderr
        timedOut = [bool]$result.timedOut
    } | ConvertTo-Json -Compress
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
finally {
    $script = $null
    $secure = $null
    $credential = $null
    $request = $null
    $requestJson = $null
}
