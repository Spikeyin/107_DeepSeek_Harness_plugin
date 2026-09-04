#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_dir="$(cd "$deployment_dir/.." && pwd)"

: "${DSH_HOME:="$repository_dir/.dsh"}"
export DSH_HOME

exec pnpm dsh --profile headless --patch "$repository_dir/plugins/dongfeng-slurm/cordis.yml" "$@"
