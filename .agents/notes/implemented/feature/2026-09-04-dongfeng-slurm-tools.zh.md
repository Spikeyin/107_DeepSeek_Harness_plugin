# Agent Note: 按用户运行的东风云 Slurm 工具

Status: implemented

[English](2026-09-04-dongfeng-slurm-tools.md) | 中文

## Problem

东风云用户需要从对话式 Harness 提交加速器和 CPU 任务，但不能把 SSH 凭据交给共享服务，也不应重复实现 Slurm 授权规则。在登录节点运行用户计算违反平台运行方式；接受任意脚本和日志路径则会把调度器元数据变成宽泛的文件系统访问入口。

## Decision

每个系统用户运行独立 Harness 进程，并以源码 overlay 加载 `plugins/dongfeng-slurm`。插件以该进程账号调用登录环境中的 Slurm CLI。它不保存 SSH 密钥、MFA 验证码、平台密码或模型凭据，也不引入共享多用户守护进程。

插件动态发现账号 association、QOS 限制以及 partition 的 account/QOS 规则。Command 模式只在请求省略时使用部署配置的 partition 与 QOS 默认值；它会推断无歧义的 account，依据当前获准组合检查 CPU、内存、GPU 和时限请求，并把 account 与资源设置作为 `sbatch` argv 传递。Slurm 仍是最终权威，在本地预检后仍可拒绝请求。Script 模式原样提交已有 `.sbatch` 文件，且不接受结构化资源覆盖。

每个获准工作目录、脚本、生成的 command 文件和可读日志都会规范化解析到一个配置工作根目录内。东风云 overlay 把该根目录设置为 `$HOME/projects`。已有脚本可以让 Slurm 把输出写到其他位置，但插件会拒绝读取这些日志。详情、日志和取消调用会查询当前用户名，并在操作前独立比较 Slurm 返回的用户名及 UID 与 Harness 进程。

查询操作不会修改父级状态，因此选择并行工具调度。提交和取消保持独占。提交经过普通工具准入后直接运行；只有取消会请求 Harness 审批。因此，没有审批渠道的 headless 组合会关闭式拒绝取消。

所有外部程序都在激活时解析。调用使用明确 argv、有界收集输出、调用方取消、截止时间以及等待进程树退出。稳定的 `SLURM_*` 错误码区分命令缺失、调度器拒绝、无效响应、禁止路径、资源限制、作业缺失和非本人作业。

## Alternatives considered

**共享多用户 Harness 服务**——拒绝，因为其服务账号会绕过按用户 Slurm 授权，或者需要模拟用户并保存更多凭据。

**由插件 SSH 到调度器主机**——拒绝，因为 Harness 已经在用户登录环境中运行。额外 SSH 跳转只会增加密钥与 MFA 处理，却不会增加授权边界。

**信任配置的资源表**——拒绝，因为 Slurm association 和 QOS 权限可以独立于源码检出变化。部署默认值仍可配置，但每次结构化提交都会读取当前权限。

**允许 Slurm 记录中的任意文件路径**——拒绝，因为作业元数据不构成本地文件读取授权。规范化包含检查把文件访问限制在用户声明的项目根目录内。

## Consequences

用户可以从 Harness 发现资源，并完成提交、查看、日志和取消生命周期，而计算由 Slurm 以其本人身份执行。运维方需要为每位用户保留一个轻量 loopback 控制进程，并可在不修改 TypeScript 的情况下更改默认值。

实现依赖 Slurm JSON 和登录环境中的 CLI 可用性。它有意省略 array、多节点作业、依赖链、reservation、交互执行、实时日志 follow、上传和环境安装。需要这些能力的用户必须在配置根目录内编写并提交合适的批处理脚本，但根目录外的日志仍不能通过插件读取。

## Verification

单元 fixture 只替换外部命令服务，并覆盖 Slurm JSON、可解析 job id、资源限制、失败、所有权、路径包含、日志上限、注册清理、并发分类和取消审批。一个无密钥录制会话通过已发布的 headless profile 加载真实 overlay，并用确定性 Slurm 响应覆盖资源发现、脚本提交、作业详情和日志渲染。
