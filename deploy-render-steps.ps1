# deploy-render-steps.ps1 - Renderside steps only (repo already pushed).
# Usage: $env:RENDER_KEY='<key>'; powershell -File deploy-render-steps.ps1
$ErrorActionPreference = 'Stop'
$RENDER_KEY = $env:RENDER_KEY
$RD_HEADERS = @{
  Authorization  = "Bearer $RENDER_KEY"
  Accept         = 'application/json'
  'Content-Type' = 'application/json'
}
Write-Output '== STEP 3: Render service =='
$owners = Invoke-RestMethod -Method GET -Uri 'https://api.render.com/v1/owners?limit=1' -Headers $RD_HEADERS
if ($owners.owner) { $ownerId = $owners.owner.id; $ownerName = $owners.owner.name }
else { $ownerId = $owners[0].id; $ownerName = $owners[0].name }
Write-Output "workspace: $ownerId ($ownerName)"

$kv = @{}
Get-Content 'rail-check2.txt' | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { $kv[$Matches[1]] = $Matches[2] }
}
$bytes = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$sessionSecret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()

$envVars = @(
  @{ key = 'NODE_ENV';            value = 'production' },
  @{ key = 'SESSION_SECRET';      value = $sessionSecret },
  @{ key = 'DATABASE_PATH';       value = '/tmp/database.sqlite' },
  @{ key = 'UPLOAD_DIR';          value = '/tmp/uploads' },
  @{ key = 'AUTO_SEED';           value = 'true' },
  @{ key = 'INSTITUTION_NAME';    value = 'Federal Poly Ilaro' },
  @{ key = 'INSTITUTION_SHORT_NAME'; value = 'FPI' },
  @{ key = 'SMTP_HOST';           value = 'smtp.gmail.com' },
  @{ key = 'SMTP_PORT';           value = '587' },
  @{ key = 'SMTP_SECURE';         value = 'false' },
  @{ key = 'SMTP_FROM_NAME';      value = 'EduMemo' },
  @{ key = 'SMTP_USER';           value = $kv['SMTP_USER'] },
  @{ key = 'SMTP_FROM_EMAIL';     value = $kv['SMTP_FROM_EMAIL'] },
  @{ key = 'SMTP_PASSWORD';       value = $kv['SMTP_PASSWORD'] },
  @{ key = 'VAPID_PUBLIC_KEY';    value = $kv['VAPID_PUBLIC_KEY'] },
  @{ key = 'VAPID_PRIVATE_KEY';   value = $kv['VAPID_PRIVATE_KEY'] },
  @{ key = 'VAPID_SUBJECT';       value = 'mailto:' + $kv['SMTP_USER'] },
  @{ key = 'SEED_ADMIN_EMAIL';    value = $kv['SEED_ADMIN_EMAIL'] },
  @{ key = 'SEED_ADMIN_PASSWORD'; value = $kv['SEED_ADMIN_PASSWORD'] }
)

$payload = @{
  type = 'web_service'; name = 'edumemo'; ownerId = $ownerId
  repo = 'https://github.com/Adeywale/edumemo'; branch = 'master'; autoDeploy = 'no'
  envVars = $envVars
  serviceDetails = @{
    runtime = 'node'; plan = 'free'; healthCheckPath = '/api/config'
    envSpecificDetails = @{ buildCommand = 'npm ci'; startCommand = 'npm start' }
  }
}
$existing = Invoke-RestMethod -Method GET -Uri 'https://api.render.com/v1/services?limit=20' -Headers $RD_HEADERS
$svc = $existing | Where-Object { $_.service.name -eq 'edumemo' } | Select-Object -First 1
if ($svc) {
  $svcId = $svc.service.id
  Write-Output "service already exists: $svcId - reusing"
} else {
  $svc = Invoke-RestMethod -Method POST -Uri 'https://api.render.com/v1/services' `
    -Headers $RD_HEADERS -ContentType 'application/json' `
    -Body ($payload | ConvertTo-Json -Depth 10)
  $svcId = $svc.id
  Write-Output "service created: $svcId"
}
Write-Output "SERVICE_ID=$svcId"

# ---------------------------------------------------------------------------
# STEP 4 - Trigger deploy and stream status until live.
# ---------------------------------------------------------------------------
Write-Output '== STEP 4: deploy =='
$dep = Invoke-RestMethod -Method POST -Uri "https://api.render.com/v1/services/$svcId/deploys" `
  -Headers $RD_HEADERS -ContentType 'application/json' -Body '{}'
$deployId = $dep.id
Write-Output "deploy started: $deployId"
$deadline = (Get-Date).AddMinutes(25)
$status = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 20
  $dep = Invoke-RestMethod -Method GET -Uri "https://api.render.com/v1/services/$svcId/deploys/$deployId" -Headers $RD_HEADERS
  if ($dep.status -ne $status) { $status = $dep.status; Write-Output "  status: $status ($((Get-Date).ToString('HH:mm:ss')))" }
  if ($status -in @('live','build_failed','deactivated')) { break }
}
if ($status -ne 'live') { throw "deploy ended as '$status'" }

# ---------------------------------------------------------------------------
# STEP 5 - Set BASE_URL to the assigned public URL, redeploy.
# ---------------------------------------------------------------------------
$svc = Invoke-RestMethod -Method GET -Uri "https://api.render.com/v1/services/$svcId" -Headers $RD_HEADERS
$publicUrl = $svc.serviceDetails.url
Write-Output "public URL: $publicUrl"
$envVars += @{ key = 'BASE_URL'; value = $publicUrl }
Invoke-RestMethod -Method PUT -Uri "https://api.render.com/v1/services/$svcId/env-vars" `
  -Headers $RD_HEADERS -ContentType 'application/json' `
  -Body (($envVars | ConvertTo-Json -Depth 5)) | Out-Null
Write-Output 'BASE_URL set'
$dep = Invoke-RestMethod -Method POST -Uri "https://api.render.com/v1/services/$svcId/deploys" `
  -Headers $RD_HEADERS -ContentType 'application/json' -Body '{}'
$deployId2 = $dep.id
Write-Output "redeploy started: $deployId2"
$deadline = (Get-Date).AddMinutes(25)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 20
  $dep = Invoke-RestMethod -Method GET -Uri "https://api.render.com/v1/services/$svcId/deploys/$deployId2" -Headers $RD_HEADERS
  if ($dep.status -ne $status) { $status = $dep.status; Write-Output "  status: $status" }
  if ($status -in @('live','build_failed','deactivated')) { break }
}
if ($status -ne 'live') { throw "redeploy ended as '$status'" }

# ---------------------------------------------------------------------------
# STEP 6 - Verify the live site.
# ---------------------------------------------------------------------------
Write-Output '== STEP 6: live verification =='
$cfg   = Invoke-WebRequest -UseBasicParsing "$publicUrl/api/config"
$login = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 "$publicUrl/login"
$sw    = Invoke-WebRequest -UseBasicParsing "$publicUrl/service-worker.js"
$admin = Invoke-WebRequest -UseBasicParsing "$publicUrl/admin/login"
Write-Output "/api/config        -> $($cfg.StatusCode) $($cfg.Content)"
Write-Output "/login             -> $($login.StatusCode)"
Write-Output "/service-worker.js -> $($sw.StatusCode)"
Write-Output "/admin/login       -> $($admin.StatusCode)"
Write-Output ''
Write-Output 'DEPLOYMENT COMPLETE'
Write-Output "  App:        $publicUrl"
Write-Output "  Admin:      $publicUrl/admin/login"
Write-Output "  Admin user: $($kv['SEED_ADMIN_EMAIL'])"
