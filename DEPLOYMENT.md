# Dongfeng Cloud deployment

English | [中文](DEPLOYMENT.zh.md)

Run one Harness process per Dongfeng system account. The process uses that account's Slurm associations and QOS permissions, stores Harness state under the checkout by default, and exposes the Web service only on loopback.

## Prepare the account

Install Node.js 24 in a directory owned by the user and activate pnpm 11.7.0 through Corepack. Keep the source checkout and `$HOME/projects` private to the account.

From the checkout root, install dependencies and build:

```sh
corepack enable
corepack install --global pnpm@11.7.0
pnpm install --frozen-lockfile
pnpm run build
mkdir -p "$HOME/projects"
```

On a cluster that forbids computation on login nodes, put dependency installation, compilation, and tests in a small CPU Slurm batch script. The Harness Web control process may remain on the login node when cluster policy permits it; user workloads submitted through the plugin always run in Slurm.

## Verify the overlay

The launch scripts load `plugins/dongfeng-slurm/cordis.yml`. Check the composed Web profile without contacting a model provider:

```sh
DSH_HOME="$PWD/.dsh" pnpm dsh --profile web --patch ./plugins/dongfeng-slurm/cordis.yml --dump-config
```

The output includes the `dongfeng-slurm` row. A normal startup also resolves `sbatch`, `squeue`, `scontrol`, `sacct`, `sacctmgr`, `sinfo`, `scancel`, and `tail`; startup fails before tools register when any command is unavailable.

## Configure Slurm behavior

The source contains no account-specific resource limits. The plugin discovers current associations, QOS limits, partition account rules, and partition QOS rules for every structured submission; Slurm remains the final authority.

| Environment variable | Default | Meaning |
|---|---:|---|
| `DSH_SLURM_WORK_ROOT` | `$HOME/projects` | Root containing every accepted work directory, script, and readable log |
| `DSH_SLURM_DEFAULT_PARTITION` | `Students` | Partition used when command mode omits one |
| `DSH_SLURM_DEFAULT_QOS` | `qos_stu_default` | QOS used when command mode omits one |
| `DSH_SLURM_COMMAND_TIMEOUT_MS` | `15000` | Deadline for one Slurm CLI call |
| `DSH_SLURM_LOG_MAX_BYTES` | `65536` | Maximum returned bytes for each log stream |
| `DSH_SLURM_LIST_MAX_ITEMS` | `100` | Maximum job records returned by one list call |
| `DSH_SLURM_CANCEL_REQUIRES_APPROVAL` | `true` | Whether cancellation requests human approval |
| `DSH_SLURM_RAW_OUTPUT_MAX_BYTES` | `1048576` | Maximum Slurm JSON bytes retained per command |
| `DSH_SLURM_GRACE_MS` | `3000` | Process-tree termination grace period |

Cordis configuration may set the same fields directly. Invalid limits fail during plugin activation. `slurm_resources` warns when the configured default partition/QOS pair is not authorized; set both default environment variables to one returned combination before relying on omitted values. A path is accepted only after canonical resolution stays inside the configured root; existing scripts and readable logs must be regular files, and final-component symbolic links are rejected.

## Start and connect

Start the loopback-only Web service on the server:

```sh
./deployment/run-web.sh
```

From the local machine, keep an SSH forwarding connection open:

```sh
ssh -N -L 3080:127.0.0.1:3080 pb22111627@114.214.255.132
```

Open the tokenized URL printed by the remote process. Do not expose port 3080 on a public interface.

## Configure the model securely

Use the Web settings page to enter the official DeepSeek API key. The credential store belongs to `.dsh/`; the key must not appear in chat, Git, deployment documentation, shell history, Slurm scripts, or copied command output.

Headless automation may read `DEEPSEEK_API_KEY` from an inherited environment or ignored `.env` file. An OpenAI-compatible gateway can use [`deployment/settings.yaml.example`](deployment/settings.yaml.example), but that file stores only route metadata and the name of an environment variable, never the secret value.

## Operate jobs

Ask the model to show available Slurm resources before selecting account, partition, and QOS. Command mode infers the account when exactly one current combination matches, requires it when several accounts match, passes it explicitly to `sbatch`, creates a private `.dsh-slurm/<uuid>/job.sbatch` directory below the chosen work directory, and writes stdout and stderr there. Script mode submits an existing `.sbatch` file unchanged and accepts no structured resource override; the script must declare its account when the cluster has no usable default account.

Job listing is constrained to the current username. Detail, log, and cancellation operations also compare the Slurm record's UID and username with the Harness process. Cancellation is exclusive and requests approval by default; a headless session with no approval channel rejects it.

Existing scripts may direct output outside the configured root, but `slurm_read_logs` refuses to read such paths. This prevents the plugin from turning a Slurm record into arbitrary filesystem access.

## Keep state private

`.env` and `.dsh/` are ignored by Git. Do not copy another user's `.dsh/` directory: it contains sessions, credentials, and local state. Do not share one Harness process between system users, because the plugin intentionally derives authorization from the process account.
