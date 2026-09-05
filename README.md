# 107 DeepSeek Harness Plugin

English | [中文](README.zh.md)

Run DeepSeek Harness on a Dongfeng Cloud login host and use a conversation to discover Slurm resources, submit batch jobs, inspect status, read bounded logs, and request job cancellation. Harness runs as the logged-in Linux user, so Slurm continues to apply that user's account, QOS, and filesystem permissions.

## Table of Contents

- [Why this project exists](#why-this-project-exists)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Start Harness and configure a model](#start-harness-and-configure-a-model)
- [Verify the Dongfeng Slurm plugin](#verify-the-dongfeng-slurm-plugin)
- [Use the Web UI remotely](#use-the-web-ui-remotely)
- [Configure and extend the plugin](#configure-and-extend-the-plugin)
- [Develop and test](#develop-and-test)
- [Limits and safety](#limits-and-safety)

<a id="why-this-project-exists"></a>
## Why this project exists

Dongfeng Cloud users need a conversational interface for Slurm without moving their platform permissions into a shared service. This project keeps the scheduler as the authority: the plugin runs its commands in the user's login environment, and Slurm decides whether each request is allowed.

The delivered work covers the full first-version batch lifecycle rather than only job submission. It includes dynamic discovery of account, partition, QOS, and resource limits; structured and existing-script submission; job listing and detail; bounded log reading; approval-gated cancellation; ownership checks; path confinement; Slurm JSON parsing; focused unit tests; and a keyless recorded Harness session. The `hello-dsh-plugin` directory remains a small, independent example for learning ordinary Cordis tool registration.

<a id="architecture"></a>
## Architecture

The model provider and Slurm are deliberately separate. A model interprets the user's request and selects a tool, while the plugin performs every scheduler operation locally under the process account.

```text
Browser or headless prompt
           |
           v
DeepSeek Harness agent -- ctx.llm --> OpenAI-compatible model API
           |
           v
    ctx.tools: slurm_* tools
           |
           v
dongfeng-slurm overlay
  |              |                |
  |              |                +-- ctx.fs confines paths to $HOME/projects
  |              +------------------- ctx.subprocess uses fixed Slurm argv
  +---------------------------------- sbatch, squeue, scontrol, sacct, scancel
                                             |
                                             v
                                          Slurm cluster
```

`plugins/dongfeng-slurm` is a source overlay. Its activation resolves the required Slurm programs before registering tools. Each structured submission re-reads the current user's Slurm permissions, so the deployment does not contain an account-specific resource table.

<a id="prerequisites"></a><a id="run-from-source"></a>
## Prerequisites

Use one Harness checkout and one Harness process for each Dongfeng Linux account. The account needs a working Slurm login environment and a writable `$HOME/projects` directory. Do not run workloads on the login node; the Harness control process may run there when the platform permits it, but user computation must be submitted with Slurm.

Install Node.js 24 and pnpm through Corepack, then clone and build the repository:

```sh
git clone https://github.com/Spikeyin/107_DeepSeek_Harness_plugin.git
cd 107_DeepSeek_Harness_plugin
corepack enable
corepack install --global pnpm@11.7.0
pnpm install --frozen-lockfile
pnpm run build
mkdir -p "$HOME/projects"
```

On a cluster that disallows installation or compilation on its login host, submit the `pnpm install`, build, and test steps in a small CPU Slurm job. See [DEPLOYMENT.md](DEPLOYMENT.md) for that deployment path and the complete Slurm environment-variable reference.

<a id="start-harness-and-configure-a-model"></a><a id="run"></a>
## Start Harness and configure a model

The launch scripts load the Dongfeng overlay and set `DSH_HOME` to this checkout's `.dsh/` directory. That directory is ignored by Git and holds local settings, credentials, browser authentication, and sessions.

### 1. Check the composed profile

Run this command from the repository root. It does not contact a model provider or submit a job.

```sh
DSH_HOME="$PWD/.dsh" pnpm dsh --profile web --patch ./plugins/dongfeng-slurm/cordis.yml --dump-config
```

The output must contain the `dongfeng-slurm` row. If startup reports a missing Slurm command, use a Dongfeng login environment that provides `sbatch`, `squeue`, `scontrol`, `sacct`, `sacctmgr`, `sinfo`, `scancel`, and `tail`.

### 2. Configure the USTC OpenAI-compatible API

The following configuration uses an OpenAI-compatible endpoint with the `deepseek-v4-pro` model. It contains only route metadata and the name of the credential reference; never put the API key itself in either YAML file.

```sh
mkdir -p .dsh
chmod 700 .dsh
vi .dsh/settings.yaml
```

Paste this content into `.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    ustc:
      displayName: USTC LLM Gateway
      apiKeyEnv: DEEPSEEK_API_KEY
      api: openai-completions
      baseURL: https://api.llm.ustc.edu.cn/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro
          contextWindow: 262144
          reasoningEfforts: false
```

Select that route as the Harness default:

```sh
vi .dsh/cordis.patch.yml
```

Paste this content into `.dsh/cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: ustc
    model: deepseek-v4-pro
```

Start the Web UI in the next step, open its tokenized URL, and use the Models settings page to store the value for `DEEPSEEK_API_KEY`. The credential provider writes it to `.dsh/.credentials.yaml` with owner-only permissions. Do not paste a key into chat, source files, Git, shell history, Slurm scripts, or command output.

For the official DeepSeek route instead, remove the `llm-pi-ai` route selection and select `deepseek-official` in the model settings. The default route also resolves a compatible endpoint from `DEEPSEEK_BASE_URL` when that environment variable is set.

### 3. Select current Slurm defaults

Ask `slurm_resources` before choosing a default pair. After it returns one authorized partition and QOS combination, export that pair in the shell that starts Harness. For the verified Dongfeng account, the following is one valid example; other accounts must use their own discovered result.

```sh
export DSH_SLURM_DEFAULT_PARTITION=P107-RTX5090
export DSH_SLURM_DEFAULT_QOS=qos_p107-rtx5090
```

### 4. Start the Web service

Run the service on the remote login host. It listens only on loopback and prints a new authenticated URL.

```sh
./deployment/run-web.sh --host 127.0.0.1 --port 3080
```

To prove the saved API route works without opening a browser, run one headless request in another shell:

```sh
./deployment/run-headless.sh "Reply with: HARNESS_MODEL_OK"
```

The expected response contains `HARNESS_MODEL_OK`. This confirms that the launch script, `.dsh/settings.yaml`, model selection, and stored credential work together.

<a id="verify-the-dongfeng-slurm-plugin"></a>
## Verify the Dongfeng Slurm plugin

Use these prompts in the Web chat after the model route is configured. They request real tools explicitly, so the answer contains current Slurm data instead of a model guess.

### 1. Discover resources

```text
Call slurm_resources. Show my authorized account, partition, QOS, CPU, memory, GPU, and wall-time limits. Do not guess missing values.
```

The result identifies the current Linux user, deployment defaults, warnings, and permitted account/partition/QOS combinations. On the verified Dongfeng account, the returned combinations used the `competition` account with `P107-RTX5090/qos_p107-rtx5090` and `P107-A100/qos_p107-a100`; this is an example, not a deployment default for every user.

### 2. Submit a minimal job

Create a working directory beneath `$HOME/projects`, then ask Harness to submit a short command. Replace the resource values with a combination returned by the first prompt.

```sh
mkdir -p "$HOME/projects/dsh-demo"
```

```text
Call slurm_submit and submit a command-mode job named harness-demo. Run `printf "harness-demo-ok\n"` in workdir dsh-demo with account competition, partition P107-RTX5090, QOS qos_p107-rtx5090, one CPU, no GPU, and a two-minute limit. Return the job id and log paths.
```

The tool creates a private `.dsh-slurm/<uuid>/job.sbatch` directory below the work directory, submits it with `sbatch`, and returns the scheduler job id plus stdout and stderr paths. Do not reuse the example account or QOS when `slurm_resources` reports different permissions.

### 3. Inspect status and logs

Replace `<job-id>` with the id returned by `slurm_submit`.

```text
Call slurm_get_job for <job-id>, then call slurm_read_logs for both stdout and stderr. Report the state, assigned nodes, exit code, and log text.
```

A completed successful job reports `COMPLETED` and exit code `0:0`. The remote validation submitted a one-CPU job through this conversation path, observed it complete on `anode01`, and read `harness-dialog-smoke-ok` from its stdout.

### 4. List or cancel a job

Use the following prompts for jobs owned by the same Linux user. The cancellation request is exclusive and opens a Web approval card; approve it only after checking the job id and purpose.

```text
Call slurm_list_jobs and show my active jobs.
```

```text
Call slurm_cancel for <job-id>.
```

Headless sessions reject cancellation when approval is required because they have no approval channel. That is expected behavior, not a scheduling failure.

<a id="use-the-web-ui-remotely"></a>
## Use the Web UI remotely

Keep the Web service bound to `127.0.0.1` on the remote host. From the local computer, create an SSH tunnel; use local port `13080` when local port `3080` is already in use.

```sh
ssh -N -L 13080:127.0.0.1:3080 pb22111627@114.214.255.132
```

Copy the path portion of the URL printed by `dsh web` to `http://127.0.0.1:13080/`. Open that complete tokenized URL, not only the bare home page. If the browser says `dsh web authentication required`, reopen the newly printed URL; a stale tokenized link does not authenticate a new browser session.

<a id="configure-and-extend-the-plugin"></a>
## Configure and extend the plugin

The overlay is [`plugins/dongfeng-slurm/cordis.yml`](plugins/dongfeng-slurm/cordis.yml). It exposes deployment choices through `DSH_SLURM_*` environment variables, so operators do not edit TypeScript to change a working root, default partition, QOS, command timeout, log limit, list limit, raw-output limit, cancellation approval, or process-termination grace period.

```sh
export DSH_SLURM_WORK_ROOT="$HOME/projects"
export DSH_SLURM_COMMAND_TIMEOUT_MS=15000
export DSH_SLURM_LOG_MAX_BYTES=65536
export DSH_SLURM_CANCEL_REQUIRES_APPROVAL=true
./deployment/run-web.sh --host 127.0.0.1 --port 3080
```

To add a new tool, start with `plugins/hello-dsh-plugin` for a small Cordis example, or follow the Slurm plugin's split: `src/index.ts` owns tool schemas, registration, concurrency, and approval; `src/core.ts` owns Slurm parsing, path validation, and subprocess execution. New scheduler behavior must use `ctx.subprocess` with a fixed argument vector, must preserve the work-root check, and must verify job ownership before reading sensitive state or changing a job.

Add the source overlay row for a separate plugin and inspect it before using a model:

```yaml
- insert:
    - id: my-plugin
      name: './src/index.ts'
```

```sh
pnpm dsh --profile web --patch ./plugins/my-plugin/cordis.yml --dump-config
```

<a id="develop-and-test"></a>
## Develop and test

Run the focused plugin tests and its recorded Harness session from the repository root:

```sh
pnpm exec vitest run plugins/dongfeng-slurm/tests/core.spec.ts plugins/dongfeng-slurm/tests/registration.spec.ts
pnpm run test:snapshot -- -t dongfeng-slurm
```

Run these checks before publishing documentation or configuration changes:

```sh
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
pnpm run build
git diff --check
```

<a id="limits-and-safety"></a>
## Limits and safety

The plugin supports batch jobs only. It does not implement job arrays, multi-node jobs, dependencies, reservations, interactive `srun`, live log following, file upload, or environment installation. Existing scripts may write logs outside the allowed root, but `slurm_read_logs` refuses to read those paths.

All accepted work directories, scripts, generated batch files, and readable logs resolve beneath `$HOME/projects` by default. The plugin rejects traversal, out-of-root absolute paths, symbolic-link escapes, non-regular scripts, foreign jobs, malformed scheduler responses, and requests beyond discovered authorization limits. Slurm remains the final authority after this preflight.

## Further reading

- [DEPLOYMENT.md](DEPLOYMENT.md) provides the complete deployment-variable reference and cluster build guidance.
- [plugins/dongfeng-slurm/README.md](plugins/dongfeng-slurm/README.md) defines every tool, request format, result, and error code.
- [docs/architecture.md](docs/architecture.md) explains Harness extension points and capability seams.
- [SAFETY.md](SAFETY.md) describes the risks of filesystem, shell, and scheduler access.

## License

[MIT](LICENSE)
