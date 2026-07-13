$hostsPath = "$env:windir\System32\drivers\etc\hosts"
$content = Get-Content $hostsPath -Raw -ErrorAction SilentlyContinue
if ($content -notmatch '20\.205\.243\.166\s+github\.com') {
    Add-Content -Path $hostsPath -Value "`n20.205.243.166 github.com`n108.160.169.55 github.global.ssl.fastly.net"
    Write-Output "SUCCESS: Added GitHub hosts entries"
} else {
    Write-Output "SKIP: GitHub hosts entries already exist"
}
Start-Sleep -Seconds 2
