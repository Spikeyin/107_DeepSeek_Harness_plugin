# Agent Note: Per-user Dongfeng Slurm tools

Status: implemented

English | [中文](2026-09-04-dongfeng-slurm-tools.zh.md)

## Problem

Dongfeng users need to submit accelerator and CPU work from a conversational Harness without giving a shared service their SSH credentials or duplicating Slurm authorization rules. Running user computation on the login node violates the platform operating model, while accepting arbitrary script and log paths would turn scheduler metadata into broad filesystem access.

## Decision

Each system user runs an independent Harness process and loads `plugins/dongfeng-slurm` as a source overlay. The plugin invokes the login environment's Slurm CLI as that process account. It stores no SSH key, MFA code, platform password, or model credential, and it does not introduce a shared multi-user daemon.

The plugin discovers account associations, QOS limits, and partition account/QOS rules dynamically. Command-mode submission applies the deployment's partition and QOS defaults only when the request omits them, infers an unambiguous account, checks the requested CPU, memory, GPU, and wall time against the current authorized combination, and passes the account and resource settings as `sbatch` argv. Slurm remains authoritative and may reject a request after the local preflight. Script mode submits an existing `.sbatch` file unchanged and does not accept structured resource overrides.

Every admitted work directory, script, generated command file, and readable log resolves canonically under one configured work root. The Dongfeng overlay sets that root to `$HOME/projects`. Existing scripts may direct Slurm output elsewhere, but the plugin refuses to read those logs. Detail, log, and cancellation calls query the current username and independently compare both the returned username and UID with the Harness process before acting.

Queries opt into parallel tool scheduling because they mutate no parent-owned state. Submission and cancellation remain exclusive. Submission runs after ordinary tool admission; cancellation alone requests Harness approval. A headless composition without an approval channel therefore fails cancellation closed.

All external programs resolve during activation. Calls use explicit argv vectors, bounded collected output, caller cancellation, deadlines, and awaited process-tree exit. Stable `SLURM_*` error codes distinguish missing commands, scheduler rejection, invalid responses, forbidden paths, resource limits, missing jobs, and foreign jobs.

## Alternatives considered

**A shared multi-user Harness service** — rejected because its service account would either bypass per-user Slurm authorization or need to impersonate users and hold additional credentials.

**SSH from the plugin to the scheduler host** — rejected because Harness already runs in the user's login environment. Another SSH hop would add key and MFA handling without adding an authorization boundary.

**Trusting configured resource tables** — rejected because Slurm associations and QOS permissions can change independently of the checkout. Deployment defaults remain configurable, but every structured submission reads current permissions.

**Allowing arbitrary filesystem paths from Slurm records** — rejected because job metadata is not authority to read local files. Canonical containment keeps file access within the user's declared project root.

## Consequences

Users can discover resources and complete the submit, inspect, log, and cancel lifecycle from Harness while Slurm runs the computation under their own identity. Operators retain one lightweight loopback control process per user and can change defaults without editing TypeScript.

The implementation depends on Slurm JSON and the login environment's CLI availability. It deliberately omits arrays, multi-node jobs, dependencies, reservations, interactive execution, live log following, uploads, and environment installation. A user who needs one of those features must author and submit a suitable batch script within the configured root, except that logs outside the root remain unreadable through this plugin.

## Verification

Unit fixtures replace only the external command service and cover Slurm JSON, parsable job ids, resource limits, failures, ownership, path containment, log bounds, registration cleanup, concurrency classification, and cancellation approval. A keyless recorded session loads the real overlay through the shipped headless profile and exercises resource discovery, script submission, job detail, and log rendering with deterministic Slurm responses.
