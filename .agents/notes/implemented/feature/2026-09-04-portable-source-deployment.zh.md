# Agent Note: Portable source deployment

Status: implemented

[English](2026-09-04-portable-source-deployment.md) | 中文

## Problem

源码检出可能依赖某一台机器的 Harness home、绝对插件路径、provider 设置和 API key。把这些状态复制到另一台服务器会连同凭据和会话一起带走，而被跟踪的凭据会向所有仓库读取者暴露密钥。

## Decision

仓库提供被 Git 忽略的 `.env.example`、被 Git 忽略的仓库内 `.dsh/` 默认目录，以及 Bash 和 PowerShell 启动脚本。脚本允许操作人员覆盖 `DSH_HOME`，保留调用目录作为 agent workspace，并通过相对路径挂载 hello 插件。provider 模板只包含路由元数据，并通过环境变量引用解析密钥。

`DEPLOYMENT.md` 及其中文对侧文件负责说明官方 DeepSeek 密钥、OpenAI 兼容网关、仅 loopback 的远程 Web 访问和配置验证。被跟踪的文档绝不包含凭据值。

## Verification

`DEPLOYMENT.md` 中的配置 dump 命令会加载 Web profile 和相对 hello-plugin overlay，不发起模型请求。hello 插件在本检出中具有直接的注册表执行与 dispose 检查。

## Alternatives considered

**把已填充的 Harness home 复制到每台服务器。** 这种方式会把会话和凭据与 provider 设置一起复制，并让部署状态依赖未跟踪的机器目录。

**保留绝对 `file:///` 插件路径。** 它只能指向某一个 Windows 检出。相对 overlay 的路径会在仓库移动后保持有效。

**把 API key 存入 provider 设置或文档。** 两者都可能被跟踪或轻易复制。凭据引用让 provider profile 可以迁移，而不发布密钥。

## Consequences

官方 DeepSeek 部署只需在 `.env` 或继承环境中提供密钥。任意兼容网关仍需端点、模型 id 和协议设置，因为这些事实无法从密钥推断。每个部署默认拥有独立本地状态；只有显式导出 `DSH_HOME` 才会共享状态。
