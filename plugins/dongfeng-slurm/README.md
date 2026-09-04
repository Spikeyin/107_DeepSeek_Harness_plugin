# Dongfeng Slurm source overlay

English | [中文](README.zh.md)

This overlay lets one DeepSeek Harness process discover and operate Slurm jobs as the operating-system user that runs it. It supports the complete batch-job path without storing SSH keys, MFA codes, platform passwords, or model credentials.

## Contents

- [Tools](#tools)
- [Submission requests](#submission-requests)
- [Resource discovery](#resource-discovery)
- [Job queries and logs](#job-queries-and-logs)
- [Security and approval](#security-and-approval)
- [Errors](#errors)
- [Load and verify](#load-and-verify)
- [Known limitations](#known-limitations)

<a id="tools"></a>

## Tools

The tools use the current username and effective UID. Query tools may run concurrently; submission and cancellation remain exclusive.

| Tool | Input | Result |
|---|---|---|
| `slurm_resources` | No fields | Deployment defaults, current user, warnings, and authorized cluster/account/partition/QOS combinations with known CPU, memory, GPU, and wall-time limits |
| `slurm_submit` | One `request` in command or script mode | Job ID, optional cluster, script and work-directory paths, log paths, and final resources for command mode |
| `slurm_list_jobs` | Optional ISO `since`, state list, and bounded `limit` | Normalized active jobs, or accounting history when `since` is present |
| `slurm_get_job` | Numeric `jobId` | State, queue reason, account, resources, nodes, exit status, timestamps, and log paths |
| `slurm_read_logs` | Numeric `jobId`, `stdout`/`stderr`/`both`, and optional byte cap | Per-stream path, text, existence, and truncation status |
| `slurm_cancel` | Numeric `jobId` | `cancelled`, or `already-finished` when completion wins the cancellation race |

<a id="submission-requests"></a>

## Submission requests

Command mode accepts a job name, command text, optional work directory, and structured resources. The plugin writes the command verbatim to a private `job.sbatch` file; it passes the account and resource values only as separate `sbatch` arguments.

```json
{
  "request": {
    "type": "command",
    "name": "training-run",
    "command": "python train.py",
    "workdir": "my-project",
    "account": "competition",
    "partition": "P107-RTX5090",
    "qos": "qos_p107-rtx5090",
    "cpus": 4,
    "memoryMb": 8192,
    "gpus": 1,
    "gpuType": "RTX5090",
    "timeMinutes": 60
  }
}
```

`account` is optional when exactly one authorized account matches the selected partition and QOS. The plugin rejects an ambiguous selection and asks the caller to provide the account.

Script mode accepts only an existing `.sbatch` path and an optional work directory. The plugin does not rewrite the file or add structured resource overrides, so the script must declare an account when the cluster has no usable default account.

```json
{
  "request": {
    "type": "script",
    "scriptPath": "my-project/train.sbatch",
    "workdir": "my-project"
  }
}
```

<a id="resource-discovery"></a>

## Resource discovery

`slurm_resources` reads the user's associations, authorized QOS records, and partition account/QOS rules from Slurm 25.11 JSON. It intersects those records instead of treating every visible partition and QOS as a valid pair. Per-user QOS maxima are safe upper bounds for one new job, and Slurm remains the final authority when current jobs consume part of a shared limit.

Command submission repeats discovery immediately before `sbatch`. It rejects unauthorized combinations and known CPU, memory, GPU, or wall-time excesses before creating a scheduler job. The result includes a warning when the deployment's default partition/QOS pair is not currently authorized; select a returned combination or override the defaults described in the [deployment guide](../../DEPLOYMENT.md#configure-slurm-behavior).

<a id="job-queries-and-logs"></a>

## Job queries and logs

`slurm_list_jobs` uses `squeue` for active jobs. Supplying `since` switches to `sacct`, normalizes the timestamp to ISO UTC, and applies optional state filtering. The configured list cap limits returned records.

`slurm_get_job` checks the live controller first and falls back to accounting history. Slurm 25.11 wrapped state, CPU, exit-code, and epoch-time values are normalized into stable strings and numbers. A completed job can disappear between ownership verification and a later operation; cancellation reports that race as `already-finished`.

`slurm_read_logs` expands `%j`, `%A`, `%x`, and `%u` in recorded log names and returns a bounded tail. Missing streams are explicit non-errors with `exists: false`; paths outside the work root, symbolic links, directories, and non-regular files are rejected.

<a id="security-and-approval"></a>

## Security and approval

The default overlay admits only working directories, scripts, generated files, and readable logs under `$HOME/projects`. Canonical `ctx.fs` resolution and containment checks reject `..`, absolute escapes, and symbolic-link targets. Generated directories use private permissions, and `job.sbatch` is created exclusively with user-only permissions.

Every detail, log, and cancellation request compares both the Slurm username and UID with the Harness process. Scheduler commands receive fixed argv arrays, ignored stdin, bounded stdout/stderr, cooperative cancellation, deadlines, and awaited process-tree exit.

Only `slurm_cancel` installs a `tools/pre-execute` approval decision. Web sessions can ask the user to confirm; headless sessions without an approval channel fail closed when confirmation is required.

<a id="errors"></a>

## Errors

All plugin failures use stable codes so the model and operator can distinguish recovery paths.

| Code | Meaning |
|---|---|
| `SLURM_COMMAND_UNAVAILABLE` | A required executable or POSIX identity is unavailable during activation |
| `SLURM_REJECTED` | Slurm rejected a request, a command failed, or a command was cancelled or timed out |
| `SLURM_INVALID_RESPONSE` | JSON, parsable output, arguments, or required response fields are invalid |
| `SLURM_FORBIDDEN_PATH` | A path escapes the work root or is not an admitted directory or regular file |
| `SLURM_RESOURCE_LIMIT` | A selection is unauthorized, ambiguous, over a discovered limit, or over a configured result cap |
| `SLURM_JOB_NOT_FOUND` | Neither the controller nor accounting history contains the requested job |
| `SLURM_JOB_NOT_OWNED` | Slurm's username or UID differs from the Harness process identity |

<a id="load-and-verify"></a>

## Load and verify

The overlay owns deployment defaults and `DSH_SLURM_*` overrides; TypeScript contains no account-specific resource table. Inspect the assembled profile without contacting a model provider:

```sh
pnpm dsh --profile web --patch ./plugins/dongfeng-slurm/cordis.yml --dump-config
```

A normal application start resolves `sbatch`, `squeue`, `scontrol`, `sacct`, `sacctmgr`, `sinfo`, `scancel`, and `tail` before registering tools. Run the focused local evidence with:

```sh
pnpm exec vitest run plugins/dongfeng-slurm/tests/core.spec.ts plugins/dongfeng-slurm/tests/registration.spec.ts
pnpm run test:snapshot -- -t dongfeng-slurm
```

See the [deployment guide](../../DEPLOYMENT.md) for Node and pnpm setup, Slurm-side build verification, loopback Web startup, SSH forwarding, and secure model-key entry.

<a id="known-limitations"></a>

## Known limitations

This version does not support arrays, multi-node jobs, dependencies, reservations, interactive `srun`, live log following, uploads, or environment installation. Existing scripts may write logs outside the configured root, but the plugin will not read them. Accounting history also depends on the cluster's `sacct` retention and publication behavior.
