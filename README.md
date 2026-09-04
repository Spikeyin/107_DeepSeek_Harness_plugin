# 107 DeepSeek Harness Plugin

English | [中文](README.zh.md)

This repository is a portable source checkout of DeepSeek Harness with a local Cordis plugin template.

Use it to run the Web UI or a headless agent from a server, keep each deployment's credentials and sessions local, and develop tools as source overlays.

## What this repository provides

- A source build of DeepSeek Harness (`dsh`).
- A `.env.example` template for an official DeepSeek API key.
- Launch scripts for Bash and PowerShell that use a repository-local `.dsh/` directory by default.
- `plugins/hello-dsh-plugin`, a working Cordis tool-plugin template.

<a id="run"></a>

## Quick start

The following path starts the Web UI with the bundled hello plugin and an official DeepSeek API key.

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

### 2. Configure your API key

Copy the credential template without committing the resulting `.env` file:

```sh
cp .env.example .env
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
```

Set your personal key in `.env`:

```dotenv
DEEPSEEK_API_KEY=
```

An official DeepSeek deployment requires only this key; the launch scripts load `.env` through the Harness configuration.

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
./deployment/run-headless.sh "summarize this workspace"
```

```powershell
.\deployment\run-headless.ps1 "summarize this workspace"
```

## Configure an API provider

Keep secrets in `.env` or inherited environment variables. The repository ignores `.env` and `.dsh/`, so neither credentials nor sessions belong in Git.

### Official DeepSeek API

Set `DEEPSEEK_API_KEY` in `.env` as shown above. You may set `DEEPSEEK_BASE_URL` when your DeepSeek-compatible deployment uses another endpoint.

### OpenAI-compatible gateway

Copy [`deployment/settings.yaml.example`](deployment/settings.yaml.example) to `.dsh/settings.yaml`, then set the gateway route id, `baseURL`, model id, and the environment-variable name that holds its key.

```sh
mkdir -p .dsh
cp deployment/settings.yaml.example .dsh/settings.yaml
```

Set that named key in `.env`, start the Web UI, and select the configured route before sending a request. A gateway needs its endpoint and model id as well as its API key because those values are provider-specific.

## Create a custom plugin

The hello plugin is a development overlay: DeepSeek Harness loads its TypeScript source from this checkout when the patch file is supplied.

### Copy and change the template

Copy `plugins/hello-dsh-plugin` to a directory such as `plugins/my-plugin`. In `src/index.ts`, change the exported plugin name and register your tool through `ctx.tools.register(defineTool(...))`.

In the copied `cordis.yml`, keep the source path relative to the patch file:

```yaml
- insert:
    - id: my-plugin
      name: './src/index.ts'
```

The relative path keeps the plugin valid after the checkout moves to another machine.

### Load and verify the plugin

Run the Web profile with the overlay:

```sh
pnpm dsh web --patch ./plugins/my-plugin/cordis.yml --no-open
```

Check configuration loading without contacting a model provider:

```sh
pnpm dsh --profile web --patch ./plugins/my-plugin/cordis.yml --dump-config
```

The dump lists `my-plugin` when the overlay is mounted. The supplied hello template registers a `greet` tool and provides a reference implementation.

## Run on a remote server

The Web server binds only to loopback. Forward it over SSH instead of exposing port 3080 publicly:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@server
```

Open the tokenized URL on your local machine after the remote server starts.

## Further reading

- [Portable deployment](DEPLOYMENT.md) covers gateway fields, state locations, and remote access in more detail.
- [Project architecture](docs/architecture.md) explains the plugin-based Harness design.
- [Safety notice](SAFETY.md) describes the risks of running an agent with filesystem and shell access.

## License

[MIT](LICENSE)
