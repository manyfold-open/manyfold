param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$handle = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite
)
try {
    [Console]::Out.WriteLine('{"kind":"ready"}')
    [Console]::Out.Flush()
    [void][Console]::ReadLine()
} finally {
    $handle.Dispose()
}
