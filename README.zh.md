# 107 DeepSeek Harness 插件项目

[English](README.md) | 中文

本仓库是可迁移的 DeepSeek Harness 源码检出，包含按用户运行的东风云 Slurm 插件和一个小型插件开发示例。

你可以在 Slurm 登录节点上运行 Web UI 或 headless agent。Harness 使用运行它的系统账号向 Slurm 提交计算任务；凭据和会话只保存在该账号本地。

## 本仓库提供的内容

- DeepSeek Harness（`dsh`）的源码构建。
- `plugins/dongfeng-slurm`：发现资源，并提交、列出、查看、读取日志和取消 Slurm 作业。
- Bash 和 PowerShell 启动脚本：加载 Slurm 源码 overlay，并默认使用仓库内的 `.dsh/` 目录。
- 保留为最小 Cordis 工具插件示例的 `plugins/hello-dsh-plugin`。

<a id="run"></a>

## 快速开始

以下流程会启动带东风云 Slurm 工具的 Web UI。

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

### 2. 配置模型提供方

先启动 Web UI，再在设置页中输入官方 DeepSeek API Key。凭据存储属于当前 Harness home；不要把密钥粘贴到聊天、源码、Git、Slurm 脚本或命令输出中。

Headless 运行也可以从继承环境或已忽略的 `.env` 文件读取 `DEEPSEEK_API_KEY`。需要兼容端点时可设置 `DEEPSEEK_BASE_URL`。

### 3. 启动 DeepSeek Harness

从仓库根目录运行对应脚本：

```sh
./deployment/run-web.sh
```

```powershell
.\deployment\run-web.ps1
```

服务监听 `127.0.0.1:3080`，并输出带 token 的 URL。若要运行一次 headless 任务，请向对应的 `run-headless` 脚本传入任务文本。

```sh
./deployment/run-headless.sh "show my available Slurm resources"
```

```powershell
.\deployment\run-headless.ps1 "show my available Slurm resources"
```

## 使用东风云 Slurm 工具

每位用户都以自己的系统账号启动独立 Harness 进程。插件调用登录环境中的 Slurm CLI，不保存 SSH 密钥、Authenticator 验证码或平台密码。

第一版提供 `slurm_resources`、`slurm_submit`、`slurm_list_jobs`、`slurm_get_job`、`slurm_read_logs` 和 `slurm_cancel`。它支持生成命令脚本或提交已有 `.sbatch` 文件；结构化提交前会重新检查账号/QOS 限制，敏感操作会核对作业所有权，取消前会请求审批。

默认情况下，所有工作目录、脚本和可读日志都必须解析到 `$HOME/projects` 内。用户计算必须由 Slurm 执行，不要在登录节点运行负载。第一版不支持 job array、多节点、依赖链、reservation、交互式 `srun`、实时日志 follow、文件上传或环境安装。

配置字段、SSH 转发和服务器运行方式见[部署指南](DEPLOYMENT.md)。

## 配置 OpenAI 兼容网关

将 [`deployment/settings.yaml.example`](deployment/settings.yaml.example) 复制为 `.dsh/settings.yaml`，然后设置 route id、`baseURL`、模型 id，以及保存其密钥的环境变量名。

```sh
mkdir -p .dsh
cp deployment/settings.yaml.example .dsh/settings.yaml
```

在已忽略的 `.env` 或继承环境中设置该变量，启动 Web UI 后选择配置的路由再发送请求。绝不能把密钥值写入 `settings.yaml`。

## 创建自定义插件

将 `plugins/hello-dsh-plugin` 复制到如 `plugins/my-plugin` 的目录。修改导出的插件名称，并通过 `ctx.tools.register(defineTool(...))` 注册工具。

让源码路径保持相对于 overlay 文件：

```yaml
- insert:
    - id: my-plugin
      name: './src/index.ts'
```

无需连接模型提供方即可验证 overlay：

```sh
pnpm dsh --profile web --patch ./plugins/my-plugin/cordis.yml --dump-config
```

## 访问远程服务器

请从本机转发仅监听 loopback 的 Web 服务，不要把 3080 端口直接暴露到公网：

```sh
ssh -N -L 3080:127.0.0.1:3080 user@server
```

远程服务启动后，在本机打开带 token 的 URL。

## 延伸阅读

- [可迁移与东风云部署](DEPLOYMENT.md)说明状态、环境变量覆盖和远程访问。
- [项目架构](docs/architecture.zh.md)解释插件化 Harness 的设计。
- [安全说明](SAFETY.zh.md)介绍文件系统、shell 和调度器访问的风险。

## 许可证

[MIT](LICENSE)
