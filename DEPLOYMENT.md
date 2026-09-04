# Portable deployment

English | [中文](DEPLOYMENT.zh.md)

Run this source checkout on another machine without copying local Harness state or credentials. The launch scripts keep Harness state in a repository-local `.dsh/` directory unless you export `DSH_HOME`, and they load the included hello tool plugin through a relative overlay.

## Start with a DeepSeek key

Install Node.js 22.19 or newer and enable Corepack, then clone and build the repository:

```sh
git clone https://github.com/Spikeyin/107_DeepSeek_Harness_plugin.git
cd 107_DeepSeek_Harness_plugin
corepack enable
pnpm install --frozen-lockfile
pnpm run build
cp .env.example .env
```

Set `DEEPSEEK_API_KEY` in `.env`, then start the Web UI or run one headless task:

```sh
./deployment/run-web.sh
./deployment/run-headless.sh "summarize this workspace"
```

The scripts preserve the directory from which you invoke them as the agent workspace. Invoke them from the checkout for the default setup, or export `DEEPSEEK_API_KEY` and invoke them from the workspace you want the agent to access.

### Windows

In PowerShell, copy the template and invoke the matching scripts:

```powershell
Copy-Item .env.example .env
.\deployment\run-web.ps1
.\deployment\run-headless.ps1 "summarize this workspace"
```

## Use an OpenAI-compatible gateway

Copy the provider template into the Harness home used by the launch scripts, edit its route details, and set the named key in `.env` or the inherited environment:

```sh
mkdir -p .dsh
cp deployment/settings.yaml.example .dsh/settings.yaml
```

Replace `example-gateway`, `baseURL`, `replace-with-your-model`, and `GATEWAY_API_KEY`. The compatibility settings in the template fit gateways that reject the `developer` role or require `max_tokens`; remove or change them when your gateway uses a different request format. Select the configured route in the Web UI before sending a request.

## Access a remote server

The Web profile listens on loopback. From your local machine, forward the server port over SSH:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@server
```

Open `http://127.0.0.1:3080` locally after the remote command prints its tokenized URL. Do not expose the Web port directly to the public network.

## Verify the composition

This command checks the Web profile and the hello-plugin overlay without contacting a model provider:

```sh
DSH_HOME="$PWD/.dsh" pnpm dsh --profile web --patch ./plugins/hello-dsh-plugin/cordis.yml --dump-config
```

The output includes the `hello-dsh-plugin` row. A successful startup proves configuration loading; sending a request still requires a valid provider route and key.

## Keep secrets and state local

`.env` and `.dsh/` are ignored by Git. Keep API keys in `.env`, inherited environment variables, or the Web settings credential store; never place them in `settings.yaml`, documentation, commits, or command output. Copy the example files rather than copying another machine's `.dsh/` directory, because it contains sessions, credentials, and local state.
