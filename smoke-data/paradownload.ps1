# Parallel range-download of the remainder of the Render CLI zip.
$ErrorActionPreference = 'Stop'
$dir  = "$env:USERPROFILE\.render-cli"
$url  = 'https://github.com/render-oss/cli/releases/download/v2.28.0/cli_2.28.0_windows_amd64.zip'
$end  = 9378254              # last byte index (Content-Length - 1)

# Snapshot current prefix (skip if already moved to prefix.bin).
Get-Process curl -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
$prefix = Join-Path $dir 'prefix.bin'
if (-not (Test-Path $prefix)) {
  Move-Item "$dir\render.zip" $prefix -Force
}
$base = (Get-Item $prefix).Length
if ($base -gt $end) { throw 'prefix already larger than file?' }

# Spawn N parallel curl range downloads.
$n = 8
$chunk = [math]::Ceiling(($end - $base + 1) / $n)
$parts = @()
for ($i = 0; $i -lt $n; $i++) {
  $s = $base + $i * $chunk
  if ($s -gt $end) { break }
  $e = [Math]::Min($base + (($i + 1) * $chunk) - 1, $end)
  $part = Join-Path $dir ("part{0}.bin" -f $i)
  $parts += $part
  Start-Process -FilePath curl.exe `
    -ArgumentList @('-sS','-L','--fail','--retry','20','--retry-all-errors','--speed-time','60','--speed-limit','500','-r',"$s-$e",'-o',$part,$url) `
    -WindowStyle Hidden
}
Write-Output "spawned $($parts.Count) parallel range downloads from byte $base"

# Wait for all to finish (max 15 min), reporting progress.
$deadline = (Get-Date).AddMinutes(15)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  $running = Get-Process curl -ErrorAction SilentlyContinue
  $done = ($parts | Where-Object { Test-Path $_ } | ForEach-Object { (Get-Item $_).Length } | Measure-Object -Sum).Sum
  if (-not $running) { break }
  Write-Output ("progress: {0:N0} / {1:N0} bytes" -f $done, ($end - $base + 1))
}

# Concatenate prefix + parts into the final zip.
$zip = "$dir\render.zip"
$fs = [IO.File]::Open($zip, 'Create')
try {
  foreach ($f in @($prefix) + $parts) {
    if (-not (Test-Path $f)) { throw "missing part: $f" }
    $bytes = [IO.File]::ReadAllBytes($f)
    $fs.Write($bytes, 0, $bytes.Length)
  }
} finally { $fs.Close() }

$final = (Get-Item $zip).Length
Write-Output "final zip size: $final (expected 9378255)"
if ($final -eq 9378255) { Write-Output 'DOWNLOAD COMPLETE' }
