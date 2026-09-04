# 东风云部署

[English](DEPLOYMENT.md) | 中文

每个东风云系统账号运行一个独立 Harness 进程。进程使用该账号的 Slurm association 和 QOS 权限，默认在源码检出中保存 Harness 状态，并且只在 loopback 上提供 Web 服务。

## 准备账号

把 Node.js 24 安装到用户自有目录，并通过 Corepack 激活 pnpm 11.7.0。源码检出和 `$HOME/projects` 应只允许该账号访问。

在检出根目录安装依赖并构建：

```sh
corepack enable
corepack install --global pnpm@11.7.0
pnpm install --frozen-lockfile
pnpm run build
mkdir -p "$HOME/projects"
```

如果集群禁止在登录节点执行计算，应把依赖安装、编译和测试放入一个小型 CPU Slurm 批处理脚本。当集群策略允许时，Harness Web 控制进程可以留在登录节点；通过插件提交的用户负载始终在 Slurm 中运行。

## 验证 overlay

启动脚本会加载 `plugins/dongfeng-slurm/cordis.yml`。以下命令不会连接模型提供方，可检查组合后的 Web profile：

```sh
DSH_HOME="$PWD/.dsh" pnpm dsh --profile web --patch ./plugins/dongfeng-slurm/cordis.yml --dump-config
```

输出中会出现 `dongfeng-slurm` 行。正常启动还会解析 `sbatch`、`squeue`、`scontrol`、`sacct`、`sacctmgr`、`sinfo`、`scancel` 和 `tail`；任一命令不可用时，启动会在工具注册前失败。

## 配置 Slurm 行为

源码不包含账号专属资源上限。每次结构化提交时，插件都会发现当前 association、QOS 限制、partition account 规则和 partition QOS 规则；Slurm 仍是最终权威。

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `DSH_SLURM_WORK_ROOT` | `$HOME/projects` | 包含所有可接受工作目录、脚本和可读日志的根目录 |
| `DSH_SLURM_DEFAULT_PARTITION` | `Students` | command 模式省略 partition 时使用的值 |
| `DSH_SLURM_DEFAULT_QOS` | `qos_stu_default` | command 模式省略 QOS 时使用的值 |
| `DSH_SLURM_COMMAND_TIMEOUT_MS` | `15000` | 单次 Slurm CLI 调用的截止时间 |
| `DSH_SLURM_LOG_MAX_BYTES` | `65536` | 每个日志流最多返回的字节数 |
| `DSH_SLURM_LIST_MAX_ITEMS` | `100` | 单次列表调用最多返回的作业数 |
| `DSH_SLURM_CANCEL_REQUIRES_APPROVAL` | `true` | 取消操作是否请求人工审批 |
| `DSH_SLURM_RAW_OUTPUT_MAX_BYTES` | `1048576` | 每条命令最多保留的 Slurm JSON 字节数 |
| `DSH_SLURM_GRACE_MS` | `3000` | 进程树终止宽限时间 |

Cordis 配置也可以直接设置相同字段。无效限制会让插件在激活时失败。当配置的默认 partition/QOS 对没有获得授权时，`slurm_resources` 会返回警告；依赖省略值前，应把两个默认环境变量设为工具返回的一个组合。路径只有在规范化解析后仍位于配置根目录内才会被接受；已有脚本和可读日志必须是普通文件，并且禁止最终路径组件为符号链接。

## 启动并连接

在服务器上启动只监听 loopback 的 Web 服务：

```sh
./deployment/run-web.sh
```

在本机保持 SSH 转发连接：

```sh
ssh -N -L 3080:127.0.0.1:3080 pb22111627@114.214.255.132
```

打开远端进程输出的带 token URL。不要在公网接口上暴露 3080 端口。

## 安全配置模型

在 Web 设置页中输入官方 DeepSeek API Key。凭据存储属于 `.dsh/`；密钥不得出现在聊天、Git、部署文档、shell 历史、Slurm 脚本或复制的命令输出中。

Headless 自动化可以从继承环境或已忽略的 `.env` 文件读取 `DEEPSEEK_API_KEY`。OpenAI 兼容网关可以使用 [`deployment/settings.yaml.example`](deployment/settings.yaml.example)，但该文件只能保存路由元数据和环境变量名，不能保存密钥值。

## 操作作业

选择 account、partition 和 QOS 前，先让模型显示可用 Slurm 资源。Command 模式会在当前组合只有一个匹配 account 时推断该值，在多个 account 匹配时要求显式提供，把它明确传给 `sbatch`，在所选工作目录下创建私有 `.dsh-slurm/<uuid>/job.sbatch` 目录，并把 stdout 和 stderr 写入其中。Script 模式会原样提交已有 `.sbatch` 文件，且不接受结构化资源覆盖；当集群没有可用默认 account 时，脚本必须自行声明 account。

作业列表会限定为当前用户名。详情、日志和取消操作还会把 Slurm 记录的 UID 与用户名同 Harness 进程比较。取消操作为独占执行并默认请求审批；没有审批渠道的 headless 会话会拒绝取消。

已有脚本可以把输出指向配置根目录外，但 `slurm_read_logs` 会拒绝读取这些路径。这可以防止插件把 Slurm 记录变成任意文件系统访问入口。

## 保持状态私有

`.env` 和 `.dsh/` 已被 Git 忽略。不要复制其他用户的 `.dsh/` 目录，其中包含会话、凭据和本地状态。不要让多个系统用户共享一个 Harness 进程，因为插件会有意从进程账号派生授权。
