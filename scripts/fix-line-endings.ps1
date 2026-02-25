$files = @(
    'backend/scripts/fetch-openmoji.sh',
    'frontend/scripts/fetch-openmoji.sh',
    'turn-server/docker-entrypoint.sh'
)

foreach ($f in $files) {
    if (Test-Path $f) {
        $content = [System.IO.File]::ReadAllText($f) -replace "`r`n", "`n"
        [System.IO.File]::WriteAllText($f, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Fixed: $f"
    } else {
        Write-Host "Skipped (not found): $f"
    }
}
Write-Host "Done."
