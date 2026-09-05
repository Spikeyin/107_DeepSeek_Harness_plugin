# 107 DeepSeek Harness 插件项目

[English](README.md) | 中文

在东风云登录节点运行 DeepSeek Harness，通过对话发现 Slurm 资源、提交批处理作业、查看状态、读取有界日志，以及请求取消作业。Harness 以当前登录 Linux 用户运行，因此 Slurm 继续执行该用户的账号、QOS 和文件系统权限规则。

## 目录

- [项目的意义](#why-this-project-exists)
- [架构](#architecture)
- [前提条件](#prerequisites)
- [启动 Harness 并配置模型](#start-harness-and-configure-a-model)
- [验证东风云 Slurm 插件](#verify-the-dongfeng-slurm-plugin)
- [远程使用 Web UI](#use-the-web-ui-remotely)
- [配置和扩展插件](#configure-and-extend-the-plugin)
- [开发和测试](#develop-and-test)
- [限制和安全](#limits-and-safety)

<a id="why-this-project-exists"></a>
## 项目的意义

东风云用户需要一个对话式 Slurm 接口，但不应把平台权限转移到共享服务中。本项目让调度器继续作为权限真源：插件在用户自己的登录环境中运行命令，并由 Slurm 决定每项请求是否允许。

交付内容覆盖第一版完整的批处理作业生命周期，而不只是提交作业。它包括动态发现账号、partition、QOS 和资源限制；结构化与已有脚本提交；作业列表和详情；有界日志读取；需审批的取消；所有权检查；路径限制；Slurm JSON 解析；聚焦单元测试；以及无密钥录制的 Harness 会话。`hello-dsh-plugin` 目录保留为一个独立的小型示例，用于学习普通 Cordis 工具注册。

<a id="architecture"></a>
## 架构

模型提供方和 Slurm 被有意分离。模型解释用户请求并选择工具，而插件始终以进程账号在本地执行调度器操作。

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

`plugins/dongfeng-slurm` 是一个源码 overlay。激活时，它会先解析必需的 Slurm 程序，再注册工具。每次结构化提交都会重新读取当前用户的 Slurm 权限，因此部署中不包含账号专属资源表。

<a id="prerequisites"></a><a id="run-from-source"></a>
## 前提条件

每个东风云 Linux 账号都使用独立的 Harness 检出和 Harness 进程。该账号需要可用的 Slurm 登录环境，以及一个可写的 `$HOME/projects` 目录。不要在登录节点运行负载；平台允许时 Harness 控制进程可以运行在此处，但用户计算必须由 Slurm 提交。

通过 Corepack 安装 Node.js 24 与 pnpm，再克隆和构建仓库：

```sh
git clone https://github.com/Spikeyin/107_DeepSeek_Harness_plugin.git
cd 107_DeepSeek_Harness_plugin
corepack enable
corepack install --global pnpm@11.7.0
pnpm install --frozen-lockfile
pnpm run build
mkdir -p "$HOME/projects"
```

如果集群不允许在登录节点安装或编译，请把 `pnpm install`、构建和测试步骤提交到一个小型 CPU Slurm 作业。完整部署路径和 Slurm 环境变量参考见[DEPLOYMENT.md](DEPLOYMENT.md)。

<a id="start-harness-and-configure-a-model"></a><a id="run"></a>
## 启动 Harness 并配置模型

启动脚本会加载东风云 overlay，并把 `DSH_HOME` 设为本检出中的 `.dsh/` 目录。该目录被 Git 忽略，保存本地设置、凭据、浏览器认证和会话。

### 1. 检查组合后的 profile

从仓库根目录运行以下命令。它不会连接模型提供方，也不会提交作业。

```sh
DSH_HOME="$PWD/.dsh" pnpm dsh --profile web --patch ./plugins/dongfeng-slurm/cordis.yml --dump-config
```

输出必须包含 `dongfeng-slurm` 行。如果启动报告缺少 Slurm 命令，请使用提供 `sbatch`、`squeue`、`scontrol`、`sacct`、`sacctmgr`、`sinfo`、`scancel` 和 `tail` 的东风云登录环境。

### 2. 配置 USTC OpenAI 兼容 API

以下配置使用 OpenAI 兼容端点和 `deepseek-v4-pro` 模型。它只包含路由元数据和凭据引用名称；绝不能把 API Key 写入任一 YAML 文件。

```sh
mkdir -p .dsh
chmod 700 .dsh
vi .dsh/settings.yaml
```

把以下内容粘贴到 `.dsh/settings.yaml`：

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

把该路由选为 Harness 默认模型：

```sh
vi .dsh/cordis.patch.yml
```

把以下内容粘贴到 `.dsh/cordis.patch.yml`：

```yaml
- id: agent-default-model
  config:
    provider: ustc
    model: deepseek-v4-pro
```

在下一步启动 Web UI，打开带 token 的 URL，然后在 Models 设置页中保存 `DEEPSEEK_API_KEY` 的值。凭据提供方会以仅所有者权限写入 `.dsh/.credentials.yaml`。不要把密钥粘贴到聊天、源码、Git、shell 历史、Slurm 脚本或命令输出中。

若改用官方 DeepSeek 路由，请移除 `llm-pi-ai` 路由选择，并在模型设置中选择 `deepseek-official`。默认路由也会在设置了 `DEEPSEEK_BASE_URL` 时解析兼容端点。

### 3. 选择当前 Slurm 默认值

请先调用 `slurm_resources`，再选择默认组合。工具返回一个获授权的 partition 与 QOS 组合后，在启动 Harness 的 shell 中导出该组合。对于已验证的东风云账号，以下是一种有效示例；其他账号必须使用其自行发现的结果。

```sh
export DSH_SLURM_DEFAULT_PARTITION=P107-RTX5090
export DSH_SLURM_DEFAULT_QOS=qos_p107-rtx5090
```

### 4. 启动 Web 服务

在远程登录节点运行服务。它只监听 loopback，并输出一个新的已认证 URL。

```sh
./deployment/run-web.sh --host 127.0.0.1 --port 3080
```

若要在不打开浏览器的情况下证明已保存 API 路由可用，请在另一个 shell 运行一次 headless 请求：

```sh
./deployment/run-headless.sh "Reply with: HARNESS_MODEL_OK"
```

预期响应包含 `HARNESS_MODEL_OK`。这证明启动脚本、`.dsh/settings.yaml`、模型选择和已保存凭据能够协同工作。

<a id="verify-the-dongfeng-slurm-plugin"></a>
## 验证东风云 Slurm 插件

在模型路由配置完成后，在 Web 聊天中使用以下提示词。它们明确要求实际调用工具，因此回答包含当前 Slurm 数据，而不是模型猜测。

### 1. 发现资源

```text
Call slurm_resources. Show my authorized account, partition, QOS, CPU, memory, GPU, and wall-time limits. Do not guess missing values.
```

结果会标识当前 Linux 用户、部署默认值、警告和允许的 account/partition/QOS 组合。已验证的东风云账号返回了 `competition` 账号以及 `P107-RTX5090/qos_p107-rtx5090` 和 `P107-A100/qos_p107-a100` 组合；这是示例，不是每位用户的部署默认值。

### 2. 提交最小作业

在 `$HOME/projects` 下创建工作目录，然后让 Harness 提交一个短命令。请把资源值替换为第一个提示词返回的组合。

```sh
mkdir -p "$HOME/projects/dsh-demo"
```

```text
Call slurm_submit and submit a command-mode job named harness-demo. Run `printf "harness-demo-ok\n"` in workdir dsh-demo with account competition, partition P107-RTX5090, QOS qos_p107-rtx5090, one CPU, no GPU, and a two-minute limit. Return the job id and log paths.
```

工具会在工作目录下创建私有 `.dsh-slurm/<uuid>/job.sbatch` 目录，用 `sbatch` 提交作业，并返回调度器 job id、stdout 和 stderr 路径。若 `slurm_resources` 报告了不同权限，请勿复用示例中的账号或 QOS。

### 3. 检查状态和日志

请把 `<job-id>` 替换为 `slurm_submit` 返回的 id。

```text
Call slurm_get_job for <job-id>, then call slurm_read_logs for both stdout and stderr. Report the state, assigned nodes, exit code, and log text.
```

完成且成功的作业会报告 `COMPLETED` 和退出码 `0:0`。远程验证通过这条对话路径提交过一个单 CPU 作业，观察到它在 `anode01` 完成，并从 stdout 读取到 `harness-dialog-smoke-ok`。

### 4. 列出或取消作业

对同一 Linux 用户拥有的作业使用以下提示词。取消请求会独占执行并打开 Web 审批卡；只有在检查 job id 和用途后才批准。

```text
Call slurm_list_jobs and show my active jobs.
```

```text
Call slurm_cancel for <job-id>.
```

在需要审批时，headless 会话会拒绝取消，因为它没有审批渠道。这是预期行为，不是调度失败。

<a id="use-the-web-ui-remotely"></a>
## 远程使用 Web UI

让 Web 服务继续绑定在远程主机的 `127.0.0.1`。从本机创建 SSH 隧道；本机的 `3080` 已被占用时使用 `13080`。

```sh
ssh -N -L 13080:127.0.0.1:3080 pb22111627@114.214.255.132
```

把 `dsh web` 输出 URL 的路径部分复制到 `http://127.0.0.1:13080/`。请打开完整的带 token URL，而不只是裸主页。若浏览器显示 `dsh web authentication required`，请重新打开新输出的 URL；陈旧的带 token 链接不能认证新的浏览器会话。

<a id="configure-and-extend-the-plugin"></a>
## 配置和扩展插件

overlay 文件是 [`plugins/dongfeng-slurm/cordis.yml`](plugins/dongfeng-slurm/cordis.yml)。它通过 `DSH_SLURM_*` 环境变量暴露部署选择，因此运维人员不必编辑 TypeScript 就能修改工作根目录、默认 partition、QOS、命令超时、日志上限、列表上限、原始输出上限、取消审批和进程终止宽限时间。

```sh
export DSH_SLURM_WORK_ROOT="$HOME/projects"
export DSH_SLURM_COMMAND_TIMEOUT_MS=15000
export DSH_SLURM_LOG_MAX_BYTES=65536
export DSH_SLURM_CANCEL_REQUIRES_APPROVAL=true
./deployment/run-web.sh --host 127.0.0.1 --port 3080
```

要增加新工具，请以 `plugins/hello-dsh-plugin` 作为小型 Cordis 示例，或遵循 Slurm 插件的拆分：`src/index.ts` 负责工具 schema、注册、并发和审批；`src/core.ts` 负责 Slurm 解析、路径验证和子进程执行。新的调度器行为必须使用带固定参数向量的 `ctx.subprocess`，必须保留工作根目录检查，并且在读取敏感状态或修改作业前验证作业所有权。

为单独的插件添加源码 overlay 行，并在使用模型前检查它：

```yaml
- insert:
    - id: my-plugin
      name: './src/index.ts'
```

```sh
pnpm dsh --profile web --patch ./plugins/my-plugin/cordis.yml --dump-config
```

<a id="develop-and-test"></a>
## 开发和测试

从仓库根目录运行聚焦插件测试和录制的 Harness 会话：

```sh
pnpm exec vitest run plugins/dongfeng-slurm/tests/core.spec.ts plugins/dongfeng-slurm/tests/registration.spec.ts
pnpm run test:snapshot -- -t dongfeng-slurm
```

在发布文档或配置更改前运行以下检查：

```sh
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
pnpm run build
git diff --check
```

<a id="limits-and-safety"></a>
## 限制和安全

插件只支持批处理作业。它不实现 job array、多节点作业、依赖链、reservation、交互式 `srun`、实时日志 follow、文件上传或环境安装。已有脚本可以把日志写到允许根目录之外，但 `slurm_read_logs` 会拒绝读取这些路径。

默认情况下，所有接受的工作目录、脚本、生成批处理文件和可读日志都会解析到 `$HOME/projects` 内。插件会拒绝路径穿越、根目录外绝对路径、符号链接逃逸、非常规脚本、他人作业、畸形调度器响应，以及超过已发现授权上限的请求。经过这些预检后，Slurm 仍是最终权威。

## 延伸阅读

- [DEPLOYMENT.md](DEPLOYMENT.md)提供完整部署变量参考和集群构建指导。
- [plugins/dongfeng-slurm/README.zh.md](plugins/dongfeng-slurm/README.zh.md)定义每个工具、请求格式、结果和错误码。
- [docs/architecture.zh.md](docs/architecture.zh.md)解释 Harness 扩展点和能力 seam。
- [SAFETY.zh.md](SAFETY.zh.md)说明文件系统、shell 和调度器访问的风险。

## 许可证

[MIT](LICENSE)
