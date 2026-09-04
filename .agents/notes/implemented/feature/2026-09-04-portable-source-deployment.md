# Agent Note: Portable source deployment

Status: implemented

English | [中文](2026-09-04-portable-source-deployment.zh.md)

## Problem

A source checkout could depend on one machine's Harness home, absolute plugin path, provider settings, and API key. Copying that state to another server carries credentials and sessions, while a tracked credential exposes the key to every repository reader.

## Decision

The repository provides a Git-ignored `.env.example`, a Git-ignored repository-local `.dsh/` default, and Bash and PowerShell launch scripts. The scripts allow an operator to override `DSH_HOME`, preserve the invoking directory as the agent workspace, and mount the hello plugin through a relative path. The provider template contains only route metadata and resolves its key from an environment-variable reference.

`DEPLOYMENT.md` and its Chinese counterpart own the operator procedure for official DeepSeek keys, OpenAI-compatible gateways, loopback-only remote Web access, and configuration verification. Tracked documentation never contains a credential value.

## Verification

The configuration-dump command in `DEPLOYMENT.md` loads the Web profile and the relative hello-plugin overlay without a model request. The hello plugin has a direct registry execution and disposal check in this checkout.

## Alternatives considered

**Copy a populated Harness home to each server.** This copies sessions and credentials along with provider settings, and makes deployment state depend on an untracked machine directory.

**Keep an absolute `file:///` plugin path.** It only identifies one Windows checkout. A path relative to the overlay remains valid after the repository moves.

**Store an API key in provider settings or documentation.** Both are tracked or easily copied. Credential references keep the provider profile portable without publishing the secret.

## Consequences

An official DeepSeek deployment needs only a key in `.env` or the inherited environment. An arbitrary compatible gateway still requires its endpoint, model id, and protocol settings because those facts cannot be inferred from a key. Each deployment gets independent local state by default and must deliberately export `DSH_HOME` to share state.
