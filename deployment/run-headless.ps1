[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TaskArguments
)

$ErrorActionPreference = 'Stop'
$repositoryDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $env:DSH_HOME = Join-Path $repositoryDirectory '.dsh'
}

& pnpm dsh --profile headless --patch (Join-Path $repositoryDirectory 'plugins/hello-dsh-plugin/cordis.yml') @TaskArguments
exit $LASTEXITCODE
