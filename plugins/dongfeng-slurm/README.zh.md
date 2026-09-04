# 东风云 Slurm 源码 overlay

[English](README.md) | 中文

此 overlay 让一个 DeepSeek Harness 进程以运行它的操作系统用户身份发现和操作 Slurm 作业。它覆盖完整的批处理作业路径，但不保存 SSH 密钥、MFA 验证码、平台密码或模型凭据。

## 目录

- [工具](#tools)
- [提交请求](#submission-requests)
- [资源发现](#resource-discovery)
- [作业查询与日志](#job-queries-and-logs)
- [安全与审批](#security-and-approval)
- [错误](#errors)
- [加载与验证](#load-and-verify)
- [已知限制](#known-limitations)

<a id="tools"></a>

## 工具

这些工具使用当前用户名和有效 UID。查询工具可以并发运行；提交和取消保持独占。

| 工具 | 输入 | 结果 |
|---|---|---|
| `slurm_resources` | 无字段 | 部署默认值、当前用户、警告，以及获准的 cluster/account/partition/QOS 组合和已知 CPU、内存、GPU、时限上限 |
| `slurm_submit` | 一个 command 或 script 模式的 `request` | 作业 ID、可选 cluster、脚本与工作目录路径、日志路径，以及 command 模式的最终资源 |
| `slurm_list_jobs` | 可选 ISO `since`、状态列表和有界 `limit` | 标准化活动作业；提供 `since` 时返回 accounting 历史 |
| `slurm_get_job` | 数字 `jobId` | 状态、排队原因、account、资源、节点、退出状态、时间戳和日志路径 |
| `slurm_read_logs` | 数字 `jobId`、`stdout`/`stderr`/`both` 和可选字节上限 | 每个日志流的路径、文本、存在状态和截断状态 |
| `slurm_cancel` | 数字 `jobId` | `cancelled`；当完成早于取消时返回 `already-finished` |

<a id="submission-requests"></a>

## 提交请求

Command 模式接受作业名称、命令文本、可选工作目录和结构化资源。插件把命令原样写入私有 `job.sbatch` 文件；account 和资源值只作为独立 `sbatch` 参数传递。

```json
{
  "request": {
    "type": "command",
    "name": "training-run",
    "command": "python train.py",
    "workdir": "my-project",
    "account": "competition",
    "partition": "P107-RTX5090",
    "qos": "qos_p107-rtx5090",
    "cpus": 4,
    "memoryMb": 8192,
    "gpus": 1,
    "gpuType": "RTX5090",
    "timeMinutes": 60
  }
}
```

当且仅当一个获准 account 匹配所选 partition 和 QOS 时，`account` 可以省略。选择存在歧义时，插件会拒绝请求并要求调用方提供 account。

Script 模式只接受已有 `.sbatch` 路径和可选工作目录。插件不会改写文件或添加结构化资源覆盖，因此当集群没有可用默认 account 时，脚本必须自行声明 account。

```json
{
  "request": {
    "type": "script",
    "scriptPath": "my-project/train.sbatch",
    "workdir": "my-project"
  }
}
```

<a id="resource-discovery"></a>

## 资源发现

`slurm_resources` 从 Slurm 25.11 JSON 读取用户 association、获准 QOS 记录和 partition account/QOS 规则。它会对这些记录求交集，而不会把所有可见 partition 与 QOS 当作有效组合。每用户 QOS 上限是单个新作业的安全上界；当当前作业消耗共享上限的一部分时，Slurm 仍是最终权威。

Command 提交会在调用 `sbatch` 前立即重新发现资源。插件会在创建调度器作业前拒绝未获准的组合以及已知的 CPU、内存、GPU 或时限超额。部署默认 partition/QOS 对当前未获授权时，结果会包含警告；应选择返回的组合，或覆盖[部署指南](../../DEPLOYMENT.md#configure-slurm-behavior)中说明的默认值。

<a id="job-queries-and-logs"></a>

## 作业查询与日志

`slurm_list_jobs` 使用 `squeue` 查询活动作业。提供 `since` 后改用 `sacct`，把时间戳标准化为 ISO UTC，并应用可选状态过滤。配置的列表上限会限制返回记录数。

`slurm_get_job` 先查询实时控制器，然后回退到 accounting 历史。Slurm 25.11 包装的状态、CPU、退出码和 epoch 时间值会被标准化为稳定字符串与数字。已完成作业可能在所有权核对与后续操作之间消失；取消操作会把这种竞态报告为 `already-finished`。

`slurm_read_logs` 会展开记录日志名中的 `%j`、`%A`、`%x` 和 `%u`，并返回有界尾部。缺失日志流会以 `exists: false` 明确返回且不视为错误；根目录外路径、符号链接、目录和非普通文件会被拒绝。

<a id="security-and-approval"></a>

## 安全与审批

默认 overlay 只允许 `$HOME/projects` 下的工作目录、脚本、生成文件和可读日志。规范化 `ctx.fs` 解析与包含检查会拒绝 `..`、绝对路径逃逸和符号链接目标。生成目录使用私有权限，`job.sbatch` 以仅用户可访问权限独占创建。

每个详情、日志和取消请求都会把 Slurm 用户名及 UID 与 Harness 进程比较。调度器命令接收固定 argv 数组、忽略 stdin、有界 stdout/stderr、协作式取消、截止时间以及等待进程树退出。

只有 `slurm_cancel` 会安装 `tools/pre-execute` 审批决策。Web 会话可以请求用户确认；需要确认但没有审批渠道的 headless 会话会关闭式失败。

<a id="errors"></a>

## 错误

所有插件失败都使用稳定错误码，让模型和运维人员可以区分恢复方式。

| 错误码 | 含义 |
|---|---|
| `SLURM_COMMAND_UNAVAILABLE` | 激活时缺少必需可执行文件或 POSIX 身份 |
| `SLURM_REJECTED` | Slurm 拒绝请求、命令失败，或者命令被取消或超时 |
| `SLURM_INVALID_RESPONSE` | JSON、可解析输出、参数或必需响应字段无效 |
| `SLURM_FORBIDDEN_PATH` | 路径逃逸工作根目录，或不是获准目录或普通文件 |
| `SLURM_RESOURCE_LIMIT` | 选择未获授权、存在歧义、超过发现的上限或超过配置的结果上限 |
| `SLURM_JOB_NOT_FOUND` | 控制器和 accounting 历史都不包含请求的作业 |
| `SLURM_JOB_NOT_OWNED` | Slurm 用户名或 UID 与 Harness 进程身份不同 |

<a id="load-and-verify"></a>

## 加载与验证

Overlay 拥有部署默认值和 `DSH_SLURM_*` 覆盖；TypeScript 不包含账号专属资源表。以下命令不会连接模型提供方，可检查组合后的 profile：

```sh
pnpm dsh --profile web --patch ./plugins/dongfeng-slurm/cordis.yml --dump-config
```

正常应用启动会在注册工具前解析 `sbatch`、`squeue`、`scontrol`、`sacct`、`sacctmgr`、`sinfo`、`scancel` 和 `tail`。使用以下命令运行聚焦本地证据：

```sh
pnpm exec vitest run plugins/dongfeng-slurm/tests/core.spec.ts plugins/dongfeng-slurm/tests/registration.spec.ts
pnpm run test:snapshot -- -t dongfeng-slurm
```

Node 与 pnpm 配置、Slurm 端构建验证、loopback Web 启动、SSH 转发和安全模型密钥录入见[部署指南](../../DEPLOYMENT.md)。

<a id="known-limitations"></a>

## 已知限制

此版本不支持 array、多节点作业、依赖链、reservation、交互式 `srun`、实时日志 follow、上传或环境安装。已有脚本可以把日志写到配置根目录外，但插件不会读取这些日志。Accounting 历史还取决于集群的 `sacct` 保留与发布行为。
