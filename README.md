# 107 DeepSeek Harness Plugin

English | [中文](README.zh.md)

This repository is a portable DeepSeek Harness source checkout with a per-user Dongfeng Cloud Slurm plugin and a small plugin-development example.

Use it to run the Web UI or a headless agent on a Slurm login host. Harness submits computation to Slurm with the operating-system account that runs Harness; credentials and sessions remain local to that account.

## What this repository provides

- A source build of DeepSeek Harness (`dsh`).
- `plugins/dongfeng-slurm`, which discovers resources and submits, lists, inspects, reads logs for, and cancels Slurm jobs.
- Bash and PowerShell launch scripts that load the Slurm source overlay and use a repository-local `.dsh/` directory by default.
- `plugins/hello-dsh-plugin`, retained as a minimal Cordis tool-plugin example.

<a id="run"></a>

## Quick start

The following path starts the Web UI with the Dongfeng Slurm tools.

### 1. Install and build

<a id="run-from-source"></a>

Install Node.js 22.19 or newer and enable Corepack, then clone and build the source checkout:

```sh
git clone https://github.com/Spikeyin/107_DeepSeek_Harness_plugin.git
cd 107_DeepSeek_Harness_plugin
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

### 2. Configure the model provider

Start the Web UI first, then enter your official DeepSeek API key in its settings page. The credential store belongs to this Harness home; do not paste a key into chat, source files, Git, Slurm scripts, or command output.

Headless operation may instead read `DEEPSEEK_API_KEY` from the inherited environment or an ignored `.env` file. `DEEPSEEK_BASE_URL` selects a compatible endpoint when required.

### 3. Start DeepSeek Harness

Run the matching script from the repository root:

```sh
./deployment/run-web.sh
```

```powershell
.\deployment\run-web.ps1
```

The server listens on `127.0.0.1:3080` and prints its tokenized URL. For one headless task, pass the task text to the matching `run-headless` script instead.

```sh
./deployment/run-headless.sh "show my available Slurm resources"
```

```powershell
.\deployment\run-headless.ps1 "show my available Slurm resources"
```

## Use the Dongfeng Slurm tools

Each user starts a separate Harness process under their own system account. The plugin invokes the login environment's Slurm CLI and never stores an SSH key, Authenticator code, or platform password.

The first version provides `slurm_resources`, `slurm_submit`, `slurm_list_jobs`, `slurm_get_job`, `slurm_read_logs`, and `slurm_cancel`. It accepts generated command scripts or existing `.sbatch` files, rechecks account/QOS limits before structured submission, verifies job ownership for sensitive operations, and asks for approval before cancellation.

All working directories, scripts, and readable logs must resolve under `$HOME/projects` by default. Use Slurm for user computation; do not run workloads on the login node. Job arrays, multi-node jobs, dependencies, reservations, interactive `srun`, live log following, uploads, and environment installation are outside this version.

See [the deployment guide](DEPLOYMENT.md) for configuration fields, SSH forwarding, and server operation.

## Configure an OpenAI-compatible gateway

Copy [`deployment/settings.yaml.example`](deployment/settings.yaml.example) to `.dsh/settings.yaml`, then set the route id, `baseURL`, model id, and the environment-variable name that holds its key.

```sh
mkdir -p .dsh
cp deployment/settings.yaml.example .dsh/settings.yaml
```

Set that named key in an ignored `.env` file or inherited environment, start the Web UI, and select the configured route before sending a request. Never put the secret value in `settings.yaml`.

## Create a custom plugin

Copy `plugins/hello-dsh-plugin` to a directory such as `plugins/my-plugin`. Change the exported plugin name and register tools through `ctx.tools.register(defineTool(...))`.

Keep the source path relative to the overlay file:

```yaml
- insert:
    - id: my-plugin
      name: './src/index.ts'
```

Verify the overlay without contacting a model provider:

```sh
pnpm dsh --profile web --patch ./plugins/my-plugin/cordis.yml --dump-config
```

## Access a remote server

Forward the loopback-only Web service from your local machine instead of exposing port 3080 publicly:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@server
```

Open the tokenized URL locally after the remote service starts.

## Further reading

- [Portable and Dongfeng deployment](DEPLOYMENT.md) covers state, environment overrides, and remote access.
- [Project architecture](docs/architecture.md) explains the plugin-based Harness design.
- [Safety notice](SAFETY.md) describes the risks of filesystem, shell, and scheduler access.

## License

[MIT](LICENSE)
