# =============================================================================
# deploy-render.ps1 - Fully automated EduMemo deployment to Render (free plan)
#
# Usage:
#   $env:GH_TOKEN    = '<github classic PAT with public_repo scope>'
#   $env:RENDER_KEY  = '<render API key>'
#   $env:GH_USERNAME = '<your github username>'
#   powershell -File deploy-render.ps1
#
# Secrets (SMTP, VAPID, admin seed) are read at runtime from rail-check2.txt
# and sent only to Render's encrypted environment store. They never appear
# in this script, in git, or in the repo.
# =============================================================================
$ErrorActionPreference = 'Stop'
$GH_TOKEN    = $env:GH_TOKEN
$RENDER_KEY  = $env:RENDER_KEY
$GH_USER     = $env:GH_USERNAME
$REPO_NAME   = 'edumemo'
if (-not $GH_TOKEN -or -not $RENDER_KEY -or -not $GH_USER) {
  throw 'Set GH_TOKEN, RENDER_KEY and GH_USERNAME environment variables first.'
}
$GH_HEADERS = @{
  Authorization = "Bearer $GH_TOKEN"
  Accept        = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'  = 'edumemo-deploy'
}
$RD_HEADERS = @{
  Authorization = "Bearer $RENDER_KEY"
  Accept        = 'application/json'
  'Content-Type' = 'application/json'
}

function Invoke-GH($Method, $Uri, $Body = $null) {
  $args = @{ Method = $Method; Uri = $Uri; Headers = $GH_HEADERS; UseBasicParsing = $true }
  if ($Body) { $args['Body'] = ($Body | ConvertTo-Json -Depth 10); $args['ContentType'] = 'application/json' }
  try { return Invoke-RestMethod @args } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 422 -or $code -eq 409) { return $null }  # repo exists
    throw
  }
}

# ---------------------------------------------------------------------------
# STEP 1 - Create the public GitHub repo (public so Render can pull it
# without installing any GitHub App on your account).
# ---------------------------------------------------------------------------
Write-Output '== STEP 1: GitHub repo =='
$created = Invoke-GH POST 'https://api.github.com/user/repos' @{
  name = $REPO_NAME; private = $false; auto_init = $false;
  description = 'EduMemo - Web-Based Memo Distribution System'
}
if ($created) { Write-Output "created repo: $($created.full_name)" }
else { Write-Output "repo $GH_USER/$REPO_NAME already exists - reusing it" }
$REPO_URL = "https://github.com/$GH_USER/$REPO_NAME"

# ---------------------------------------------------------------------------
# STEP 2 - Commit everything not git-ignored and push (small payload over
# github.com's git endpoint - not the throttled release-CDN).
# ---------------------------------------------------------------------------
Write-Output '== STEP 2: git commit + push =='
git config user.name  $GH_USER
git config user.email "$GH_USER@users.noreply.github.com"
git add -A
git commit -m 'Deploy: Render blueprint, deploy guide, ops scripts' --allow-empty | Out-Null
$pushUrl = "https://$GH_TOKEN@github.com/$GH_USER/$REPO_NAME.git"
if (-not (git remote)) { git remote add origin $pushUrl } else { git remote set-url origin $pushUrl }
git push -u origin master 2>&1 | ForEach-Object { $_ -replace $GH_TOKEN, '***' }
git remote set-url origin $REPO_URL   # strip token from the stored remote
Write-Output "pushed to $REPO_URL (master)"

# ---------------------------------------------------------------------------
# STEP 3 - Render workspace + service creation (all env vars included).
# ---------------------------------------------------------------------------
Write-Output '== STEP 3: Render service =='
$owners = Invoke-RestMethod -Method GET -Uri 'https://api.render.com/v1/owners?limit=1' -Headers $RD_HEADERS
$ownerId = $owners[0].id
Write-Output "workspace: $ownerId ($($owners[0].name))"

# Non-secret config mirrors render.yaml; secrets come from rail-check2.txt.
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
  type = 'web'; name = $REPO_NAME; ownerId = $ownerId
  repo = $REPO_URL; branch = 'master'; autoDeploy = 'no'
  envVars = $envVars
  serviceDetails = @{
    runtime = 'node'; plan = 'free'; healthCheckPath = '/api/config'
    envSpecificDetails = @{ buildCommand = 'npm ci'; startCommand = 'npm start' }
  }
}
$existing = Invoke-RestMethod -Method GET -Uri 'https://api.render.com/v1/services?limit=20' -Headers $RD_HEADERS
$svc = $existing | Where-Object { $_.service.name -eq $REPO_NAME } | Select-Object -First 1
if ($svc) {
  $svcId = $svc.service.id
  Write-Output "service already exists: $svcId - reusing"
  Invoke-RestMethod -Method PUT -Uri "https://api.render.com/v1/services/$svcId/env-vars" `
    -Headers $RD_HEADERS -ContentType 'application/json' `
    -Body (($envVars | ConvertTo-Json -Depth 5)) | Out-Null
  Write-Output 'env vars updated'
} else {
  $svc = Invoke-RestMethod -Method POST -Uri 'https://api.render.com/v1/services' `
    -Headers $RD_HEADERS -ContentType 'application/json' `
    -Body ($payload | ConvertTo-Json -Depth 10)
  $svcId = $svc.id
  Write-Output "service created: $svcId"
}

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
  if ($dep.status -ne $status) { $status = $dep.status; Write-Output "  status: $status  ($((Get-Date).ToString('HH:mm:ss')))" }
  if ($status -in @('live','build_failed','deactivated')) { break }
}
if ($status -ne 'live') { throw "deploy ended as '$status' - check logs in the Render dashboard" }

# ---------------------------------------------------------------------------
# STEP 5 - Set BASE_URL to the assigned public URL, redeploy, verify.
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
