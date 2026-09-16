if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    [Console]::Error.WriteLine("*** NOT ELEVATED *** This repo's host-network/guest tests require an Administrator terminal. Restart this session as Administrator before running tests.")
    exit 2
}
