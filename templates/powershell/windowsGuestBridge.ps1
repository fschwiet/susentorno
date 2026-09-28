# PowerShell Direct bridge for the host-side WindowsGuestExecutor
# (src/guestSetup/windows/guestExecutor.ts). It is deliberately NOT under a
# vm-shared-* template directory, so update-shares never copies it into a guest
# share; the package resolves it through packageRoot().
#
# One invocation per process. Only -VMName is in argv. The request arrives on
# stdin as one JSON object:
#   { "username": ..., "password": ..., "scriptBase64": ..., "timeoutMs": ... }
# and exactly one JSON line leaves on stdout:
#   { "kind": "result", "exitCode", "stdout", "stderr", "timedOut" }   exit 0
#   { "kind": "error", "category": "transport|authentication|protocol", "message" }   exit 1
param(
    [Parameter(Mandatory = $true)][string] $VMName
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Envelope {
    param([Parameter(Mandatory = $true)] $Envelope)
    [Console]::Out.WriteLine(($Envelope | ConvertTo-Json -Compress))
}

$stage = 'request'
try {
    $request = ([Console]::In.ReadToEnd()) | ConvertFrom-Json
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.scriptBase64))
    $timeoutMs = [int]$request.timeoutMs
    if ($timeoutMs -le 0) { throw 'timeoutMs must be positive.' }
    if ([string]::IsNullOrEmpty([string]$request.username)) { throw 'username is required.' }

    # PowerShell 7 paths inherited by Windows PowerShell 5.1 can make the
    # Microsoft.PowerShell.Security module unloadable (confirmed live: when
    # pwsh.exe is anywhere in this process's ancestry, ConvertTo-SecureString
    # fails to load its module on every invocation). Prepending the real 5.1
    # module path must happen before the first ConvertTo-SecureString call.
    $stage = 'credential'
    $env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;$env:PSModulePath"
    $secure = ConvertTo-SecureString ([string]$request.password) -AsPlainText -Force
    $credential = [Management.Automation.PSCredential]::new([string]$request.username, $secure)
    $request.password = $null

    # Deliberately self-contained: functions defined here are not visible in
    # the PowerShell Direct runspace. The guest child is the unit of
    # execution, so its process exit code and its separately redirected
    # stdout/stderr are authoritative.
    $runner = {
        param([string] $GuestScript, [int] $GuestTimeoutMs)

        # The loader forces UTF-8 output and suppresses progress records, which
        # would otherwise pollute redirected stderr as CLIXML. The script itself
        # arrives on the child's stdin as base64, so there is no temporary file
        # and no nested quoting.
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

            $timedOut = -not $process.WaitForExit($GuestTimeoutMs)
            if ($timedOut) {
                # Kill the whole tree so no grandchild keeps the output pipes open.
                & "$env:SystemRoot\System32\taskkill.exe" /T /F /PID $process.Id 2>&1 | Out-Null
                if (-not $process.HasExited) { $process.Kill() }
                $process.WaitForExit()
                $exitCode = 124
            }
            else {
                # The second wait ensures asynchronous output handlers have drained.
                $process.WaitForExit()
                $exitCode = $process.ExitCode
            }

            $stdout = ''
            $stderr = ''
            if ($stdoutTask.Wait(10000)) { $stdout = $stdoutTask.Result }
            if ($stderrTask.Wait(10000)) { $stderr = $stderrTask.Result }
            return [pscustomobject]@{
                exitCode = [int]$exitCode
                stdout   = [string]$stdout
                stderr   = [string]$stderr
                timedOut = [bool]$timedOut
            }
        }
        finally {
            $process.Dispose()
        }
    }

    $stage = 'invoke'
    $output = @(Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock $runner -ArgumentList $script, $timeoutMs)

    $stage = 'result'
    $result = $output | Select-Object -Last 1
    if ($null -eq $result -or $null -eq $result.exitCode -or $null -eq $result.timedOut) {
        throw 'The guest runner returned no result.'
    }
    Write-Envelope ([ordered]@{
            kind     = 'result'
            exitCode = [int]$result.exitCode
            stdout   = [string]$result.stdout
            stderr   = [string]$result.stderr
            timedOut = [bool]$result.timedOut
        })
}
catch {
    $category = 'protocol'
    if ($stage -eq 'invoke') {
        # A remote terminating error means the runner itself failed inside the
        # guest, which is a bridge/protocol problem. Anything else is the
        # PowerShell Direct connection: a rejected credential is
        # authentication, and the rest (VM not running, integration services
        # not up, no logon session yet) is retryable transport.
        if ($_.Exception -is [Management.Automation.RemoteException]) {
            $category = 'protocol'
        }
        elseif ($_.Exception.Message -match 'credential is invalid') {
            $category = 'authentication'
        }
        else {
            $category = 'transport'
        }
    }
    Write-Envelope ([ordered]@{
            kind     = 'error'
            category = $category
            message  = "[$stage] $($_.Exception.Message)"
        })
    exit 1
}
finally {
    # Drop references; the process exits right after this anyway.
    $script = $null
    $secure = $null
    $credential = $null
    $request = $null
}
