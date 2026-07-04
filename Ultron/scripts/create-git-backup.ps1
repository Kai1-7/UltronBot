param(
  [string]$Prefix = "codex/backup",
  [switch]$Push
)

$ErrorActionPreference = "Stop"

$repoRoot = git rev-parse --show-toplevel
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$branchName = "$Prefix-$timestamp"
$workingTreeStatus = git -C $repoRoot status --porcelain

if ($workingTreeStatus) {
  Write-Warning "Hay cambios sin commit. El backup apuntara al ultimo commit confirmado, no al working tree."
}

git -C $repoRoot branch $branchName HEAD

if ($Push) {
  git -C $repoRoot push origin $branchName
}

Write-Host "Backup creado: $branchName"
