# 可迁移部署

[English](DEPLOYMENT.md) | 中文

你可以在另一台机器上运行这个源码检出，而无需复制本机的 Harness 状态或凭据。启动脚本会把 Harness 状态保存在仓库内的 `.dsh/`，除非你导出 `DSH_HOME`；脚本还会通过相对 overlay 加载随附的 hello 工具插件。

## 使用 DeepSeek 密钥启动

安装 Node.js 22.19 或更高版本并启用 Corepack，然后克隆并构建仓库：

```sh
git clone https://github.com/Spikeyin/107_DeepSeek_Harness_plugin.git
cd 107_DeepSeek_Harness_plugin
corepack enable
pnpm install --frozen-lockfile
pnpm run build
cp .env.example .env
```

在 `.env` 中设置 `DEEPSEEK_API_KEY`，然后启动 Web UI 或运行一次 headless 任务：

```sh
./deployment/run-web.sh
./deployment/run-headless.sh "summarize this workspace"
```

脚本会保留你调用它时所在的目录作为 agent workspace。在检出根目录调用即可使用默认设置；也可以导出 `DEEPSEEK_API_KEY` 后，在希望 agent 访问的 workspace 中调用脚本。

### Windows

在 PowerShell 中复制模板并调用对应脚本：

```powershell
Copy-Item .env.example .env
.\deployment\run-web.ps1
.\deployment\run-headless.ps1 "summarize this workspace"
```

## 使用 OpenAI 兼容网关

将 provider 模板复制到启动脚本使用的 Harness home，编辑路由信息，再在 `.env` 或继承环境中设置具名密钥：

```sh
mkdir -p .dsh
cp deployment/settings.yaml.example .dsh/settings.yaml
```

替换 `example-gateway`、`baseURL`、`replace-with-your-model` 和 `GATEWAY_API_KEY`。模板中的兼容性设置适合拒绝 `developer` 角色或要求 `max_tokens` 的网关；如果你的网关使用其他请求格式，请删除或修改它们。在发送请求前，从 Web UI 选择已配置的路由。

## 访问远程服务器

Web profile 只监听 loopback。请从本机通过 SSH 转发服务器端口：

```sh
ssh -N -L 3080:127.0.0.1:3080 user@server
```

远端命令打印带 token 的 URL 后，在本机打开 `http://127.0.0.1:3080`。不要把 Web 端口直接暴露到公网。

## 验证组合配置

这个命令会检查 Web profile 和 hello-plugin overlay，不会连接模型提供方：

```sh
DSH_HOME="$PWD/.dsh" pnpm dsh --profile web --patch ./plugins/hello-dsh-plugin/cordis.yml --dump-config
```

输出中会出现 `hello-dsh-plugin` 行。启动成功只能证明配置已加载；发送请求仍需要有效的 provider 路由和密钥。

## 保持密钥和状态在本机

`.env` 与 `.dsh/` 已被 Git 忽略。请把 API key 放在 `.env`、继承环境变量或 Web settings 凭据存储中；绝不能写入 `settings.yaml`、文档、提交或命令输出。复制示例文件，不要复制另一台机器的 `.dsh/`，因为其中包含会话、凭据和本地状态。
