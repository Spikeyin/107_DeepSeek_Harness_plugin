[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$WebArguments
)

$ErrorActionPreference = 'Stop'
$repositoryDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $env:DSH_HOME = Join-Path $repositoryDirectory '.dsh'
}

& pnpm dsh web --patch (Join-Path $repositoryDirectory 'plugins/hello-dsh-plugin/cordis.yml') --no-open @WebArguments
exit $LASTEXITCODE
