# deploy.ps1 — inicializa ou atualiza o stack de producao
# Uso: .\scripts\deploy.ps1
# Prerequisito: Docker Desktop em execucao

param(
    [switch]$Down,
    [switch]$Logs
)

$ComposeFiles = "-f docker-compose.yml -f docker-compose.prod.yml"
$EnvFile = ".env.prod"
$ProjectName = "jlmirror"

if (-not (Test-Path $EnvFile)) {
    Write-Error "Arquivo $EnvFile nao encontrado. Crie-o antes de fazer deploy."
    exit 1
}

if ($Down) {
    Write-Host "Parando o stack..."
    Invoke-Expression "docker compose --env-file $EnvFile $ComposeFiles -p $ProjectName down"
    exit 0
}

if ($Logs) {
    Invoke-Expression "docker compose --env-file $EnvFile $ComposeFiles -p $ProjectName logs -f"
    exit 0
}

Write-Host "=== Deploy JLMirror (producao) ===" -ForegroundColor Cyan
Write-Host "Env file : $EnvFile"
Write-Host "Compose  : docker-compose.yml + docker-compose.prod.yml"
Write-Host ""

# Verifica se .env.prod tem os valores minimos
$required = @(
    "POSTGRES_PASSWORD", "DB_PASSWORD", "BFF_INTERNAL_SECRET",
    "KEYCLOAK_CLIENT_SECRET", "NOTIFICATION_CALLBACK_SECRET", "KEYCLOAK_ADMIN_PASSWORD"
)
$envContent = Get-Content $EnvFile
$missing = @()
foreach ($key in $required) {
    if (-not ($envContent -match "^$key=.+")) {
        $missing += $key
    }
}
if ($missing.Count -gt 0) {
    Write-Error "Variaveis obrigatorias nao definidas em $EnvFile: $($missing -join ', ')"
    exit 1
}

Write-Host "Subindo containers..." -ForegroundColor Yellow
Invoke-Expression "docker compose --env-file $EnvFile $ComposeFiles -p $ProjectName up -d --build --remove-orphans"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy falhou. Verifique os logs com: .\scripts\deploy.ps1 -Logs"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "=== Stack no ar ===" -ForegroundColor Green
Write-Host "BFF / App : http://localhost:8080"
Write-Host "Keycloak  : http://localhost:8180  (admin: KEYCLOAK_ADMIN_PASSWORD do .env.prod)"
Write-Host "Grafana   : http://localhost:3300  (admin: GF_SECURITY_ADMIN_PASSWORD do .env.prod)"
Write-Host ""
Write-Host "Logs em tempo real: .\scripts\deploy.ps1 -Logs"
Write-Host "Parar tudo        : .\scripts\deploy.ps1 -Down"
