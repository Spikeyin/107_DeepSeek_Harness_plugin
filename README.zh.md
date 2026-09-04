# 107 DeepSeek Harness 插件项目

[English](README.md) | 中文

本仓库是可迁移的 DeepSeek Harness 源码检出，包含本地 Cordis 插件模板。

你可以在服务器上运行 Web UI 或无界面 agent，让每台部署独立保存凭据和会话，并以源码 overlay 方式开发工具。

## 本仓库提供的内容

- DeepSeek Harness（`dsh`）的源码构建。
- 用于官方 DeepSeek API Key 的 `.env.example` 模板。
- Bash 和 PowerShell 启动脚本；默认使用仓库内的 `.dsh/` 目录。
- 可运行的 Cordis 工具插件模板 `plugins/hello-dsh-plugin`。

<a id="run"></a>

## 快速开始

以下流程会使用官方 DeepSeek API Key 启动带 hello 插件的 Web UI。

### 1. 安装并构建

<a id="run-from-source"></a>

安装 Node.js 22.19 或更高版本并启用 Corepack，然后克隆并构建源码检出：

```sh
git clone https://github.com/Spikeyin/107_DeepSeek_Harness_plugin.git
cd 107_DeepSeek_Harness_plugin
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

### 2. 配置 API Key

复制凭据模板，并且不要提交生成的 `.env` 文件：

```sh
cp .env.example .env
```

在 Windows PowerShell 中，使用：

```powershell
Copy-Item .env.example .env
```

在 `.env` 中填写你的个人密钥：

```dotenv
DEEPSEEK_API_KEY=
```

官方 DeepSeek 部署只需此密钥；启动脚本会通过 Harness 配置加载 `.env`。

### 3. 启动 DeepSeek Harness

从仓库根目录运行对应脚本：

```sh
./deployment/run-web.sh
```

```powershell
.\deployment\run-web.ps1
```

服务监听 `127.0.0.1:3080`，并输出带 token 的 URL。若要运行一次无界面任务，请向对应的 `run-headless` 脚本传入任务文本。

```sh
./deployment/run-headless.sh "summarize this workspace"
```

```powershell
.\deployment\run-headless.ps1 "summarize this workspace"
```

## 配置 API Provider

请将密钥保存在 `.env` 或继承的环境变量中。仓库忽略 `.env` 和 `.dsh/`，因此凭据和会话都不应进入 Git。

### 官方 DeepSeek API

按上述方式在 `.env` 设置 `DEEPSEEK_API_KEY`。如果 DeepSeek 兼容部署使用其他端点，可以设置 `DEEPSEEK_BASE_URL`。

### OpenAI 兼容网关

将 [`deployment/settings.yaml.example`](deployment/settings.yaml.example) 复制为 `.dsh/settings.yaml`，然后填写网关 route id、`baseURL`、模型 id，以及保存其密钥的环境变量名。

```sh
mkdir -p .dsh
cp deployment/settings.yaml.example .dsh/settings.yaml
```

在 `.env` 中设置该变量名对应的密钥，启动 Web UI 后选择配置的 route 再发送请求。网关除 API Key 外还需要端点和模型 id，因为这些值取决于 provider。

## 创建自定义插件

hello 插件是开发态 overlay：传入 patch 文件时，DeepSeek Harness 会从本检出直接加载它的 TypeScript 源码。

### 复制并修改模板

将 `plugins/hello-dsh-plugin` 复制到如 `plugins/my-plugin` 的目录。在 `src/index.ts` 中修改导出的插件名称，并通过 `ctx.tools.register(defineTool(...))` 注册你的工具。

在复制后的 `cordis.yml` 中，让源码路径保持相对于 patch 文件：

```yaml
- insert:
    - id: my-plugin
      name: './src/index.ts'
```

相对路径可让插件在源码检出迁移到另一台机器后继续有效。

### 加载并验证插件

使用 overlay 运行 Web profile：

```sh
pnpm dsh web --patch ./plugins/my-plugin/cordis.yml --no-open
```

无需联系模型 provider 即可检查配置加载：

```sh
pnpm dsh --profile web --patch ./plugins/my-plugin/cordis.yml --dump-config
```

overlay 成功挂载后，输出会列出 `my-plugin`。仓库提供的 hello 模板注册 `greet` 工具，可作为实现参考。

## 在远程服务器运行

Web 服务仅绑定 loopback。请使用 SSH 转发，而不要将 3080 端口直接暴露到公网：

```sh
ssh -N -L 3080:127.0.0.1:3080 user@server
```

远程服务启动后，在本机打开带 token 的 URL。

## 延伸阅读

- [可迁移部署](DEPLOYMENT.md) 更详细说明网关字段、状态目录和远程访问。
- [项目架构](docs/architecture.zh.md) 解释插件化 Harness 的设计。
- [安全说明](SAFETY.zh.md) 介绍 agent 使用文件系统和 shell 权限时的风险。

## 许可证

[MIT](LICENSE)
