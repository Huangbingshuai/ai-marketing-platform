$ErrorActionPreference = 'Stop'

# Stop Hook reads event JSON from stdin and avoids a blocking loop.
$rawInput = [Console]::In.ReadToEnd()
$eventPayload = $null
if (-not [string]::IsNullOrWhiteSpace($rawInput)) {
    try { $eventPayload = $rawInput | ConvertFrom-Json } catch { $eventPayload = $null }
}
if ($eventPayload -and $eventPayload.stop_hook_active -eq $true) {
    [Console]::Out.WriteLine('{}')
    exit 0
}

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if (-not $repoRoot) {
    [Console]::Out.WriteLine('{}')
    exit 0
}
$repoRoot = $repoRoot.Trim()
$problems = [System.Collections.Generic.List[string]]::new()

$rootAgents = Join-Path $repoRoot 'AGENTS.md'
if (-not (Test-Path -LiteralPath $rootAgents)) {
    $problems.Add('Missing root AGENTS.md.')
} elseif ((Get-Item -LiteralPath $rootAgents).Length -gt 24576) {
    $problems.Add('Root AGENTS.md exceeds 24 KiB. Move details into nested AGENTS, skills, or workflow guides.')
}

$requiredFiles = @(
    'apps/web/AGENTS.md',
    'apps/api/AGENTS.md',
    'packages/contracts/AGENTS.md',
    'workers/AGENTS.md',
    'docs/workflows/effect/agent-guide.md',
    'docs/workflows/customized/agent-guide.md',
    'docs/workflows/fission/clone/agent-guide.md',
    'docs/workflows/fission/avatar/agent-guide.md',
    'docs/workflows/fission/local-replace/agent-guide.md',
    'docs/development/local-development.md',
    '.agents/skills/develop-workflow-node/SKILL.md',
    '.agents/skills/reproduce-prototype-ui/SKILL.md'
)
foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $relativePath))) {
        $problems.Add("Missing instruction file: $relativePath")
    }
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$diffOutput = & git -C $repoRoot diff --check 2>&1
$diffExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($diffExitCode -ne 0) {
    $problems.Add("git diff --check failed: $($diffOutput -join ' ')")
}

if ($problems.Count -gt 0) {
    $reason = "Stop guardrail check failed:`n- " + ($problems -join "`n- ")
    @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
    exit 0
}

[Console]::Out.WriteLine('{}')
