/**
 * Dongfeng Cloud Slurm tools for per-user Harness deployments. Each tool uses
 * the caller's operating-system account and the login environment's Slurm CLI;
 * the plugin stores no SSH, MFA, platform, or API credentials.
 * @module dsh-dongfeng-slurm-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  DongfengSlurmRuntime,
  SlurmError,
  resolveSlurmCommands,
  slurmJobId,
} from './core.ts'
import type { SlurmRuntimeConfig, SlurmSubmitRequest } from './core.ts'
import type {
  SlurmCancelResult,
  SlurmJob,
  SlurmLogStream,
  SlurmResources,
  SlurmSubmission,
} from './core.ts'

export * from './core.ts'

/** Cordis loader name. */
export const name = 'dongfeng-slurm'

/** Required Harness services. */
export const inject = ['tools', 'subprocess', 'fs']

/** Deployment configuration. Every value is supplied by the overlay or an operator override. */
export interface Config extends SlurmRuntimeConfig {}

/** Cordis config validator; it intentionally declares no implementation defaults. */
export const Config: z<Config> = z.object({
  workRoot: z.string().required(),
  defaultPartition: z.string().required(),
  defaultQos: z.string().required(),
  commandTimeoutMs: z.number().required(),
  logMaxBytes: z.number().required(),
  listMaxItems: z.number().required(),
  cancelRequiresApproval: z.boolean().required(),
  rawOutputMaxBytes: z.number().required(),
  graceMs: z.number().required(),
})

/** Operations consumed by the tool-registration layer. */
export interface SlurmOperations {
  resources(signal?: AbortSignal): Promise<SlurmResources>
  submit(request: SlurmSubmitRequest, signal?: AbortSignal): Promise<SlurmSubmission>
  listJobs(options: { since?: string; states?: string[]; limit?: number }, signal?: AbortSignal): Promise<SlurmJob[]>
  getJob(jobId: ReturnType<typeof slurmJobId>, signal?: AbortSignal): Promise<SlurmJob>
  readLogs(jobId: ReturnType<typeof slurmJobId>, stream: 'stdout' | 'stderr' | 'both', maxBytes: number | undefined, signal?: AbortSignal): Promise<{ stdout?: SlurmLogStream; stderr?: SlurmLogStream }>
  cancel(jobId: ReturnType<typeof slurmJobId>, signal?: AbortSignal): Promise<SlurmCancelResult>
}

const COMMAND_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true, const: 'command' },
    name: { type: 'string', required: true, description: 'Slurm job name.' },
    command: { type: 'string', required: true, description: 'Command text written verbatim into the generated batch script.' },
    workdir: { type: 'string', description: 'Working directory under the configured work root.' },
    account: { type: 'string', description: 'Authorized Slurm account; inferred when one account matches.' },
    partition: { type: 'string', description: 'Authorized partition; defaults to the deployment setting.' },
    qos: { type: 'string', description: 'Authorized QOS; defaults to the deployment setting.' },
    cpus: { type: 'integer', description: 'Requested CPUs for the single task.' },
    memoryMb: { type: 'integer', description: 'Requested memory in MiB.' },
    gpus: { type: 'integer', description: 'Requested GPU count.' },
    gpuType: { type: 'string', description: 'Optional Slurm GPU type paired with gpus.' },
    timeMinutes: { type: 'integer', description: 'Requested wall time in minutes.' },
  },
} as const

const SCRIPT_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true, const: 'script' },
    scriptPath: { type: 'string', required: true, description: 'Existing .sbatch file under the configured work root.' },
    workdir: { type: 'string', description: 'Working directory under the configured work root.' },
  },
} as const

const LIMITS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cpus: { type: 'integer' },
    memoryMb: { type: 'integer' },
    gpus: { type: 'integer' },
    timeMinutes: { type: 'integer' },
  },
} as const

const RESOURCES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    user: { type: 'string', required: true },
    defaultPartition: { type: 'string', required: true },
    defaultQos: { type: 'string', required: true },
    combinations: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cluster: { type: 'string', required: true },
          account: { type: 'string', required: true },
          partition: { type: 'string', required: true },
          qos: { type: 'string', required: true },
          limits: { ...LIMITS_OUTPUT_SCHEMA, required: true },
        },
      },
    },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const FINAL_RESOURCES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account: { type: 'string', required: true },
    partition: { type: 'string', required: true },
    qos: { type: 'string', required: true },
    cpus: { type: 'integer' },
    memoryMb: { type: 'integer' },
    gpus: { type: 'integer' },
    gpuType: { type: 'string' },
    timeMinutes: { type: 'integer' },
  },
} as const

const SUBMISSION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    cluster: { type: 'string' },
    scriptPath: { type: 'string', required: true },
    workdir: { type: 'string', required: true },
    stdoutPath: { type: 'string' },
    stderrPath: { type: 'string' },
    resources: FINAL_RESOURCES_OUTPUT_SCHEMA,
  },
} as const

const JOB_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    state: { type: 'string', required: true },
    reason: { type: 'string' },
    partition: { type: 'string' },
    qos: { type: 'string' },
    account: { type: 'string' },
    cluster: { type: 'string' },
    cpus: { type: 'integer' },
    memoryMb: { type: 'integer' },
    gpus: { type: 'integer' },
    nodes: { type: 'array', required: true, items: { type: 'string' } },
    exitCode: { type: 'string' },
    stdoutPath: { type: 'string' },
    stderrPath: { type: 'string' },
    submitTime: { type: 'string' },
    startTime: { type: 'string' },
    endTime: { type: 'string' },
    user: { type: 'string', required: true },
    uid: { type: 'integer', required: true },
  },
} as const

const LOG_STREAM_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    text: { type: 'string', required: true },
    exists: { type: 'boolean', required: true },
    truncated: { type: 'boolean', required: true },
  },
} as const

const LOGS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stdout: LOG_STREAM_OUTPUT_SCHEMA,
    stderr: LOG_STREAM_OUTPUT_SCHEMA,
  },
} as const

const CANCEL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    outcome: { type: 'string', required: true, enum: ['cancelled', 'already-finished'] },
    state: { type: 'string' },
  },
} as const

/** Register the six Slurm lifecycle tools after activation-time executable resolution. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateConfig(config)
  const user = process.env.USER?.trim() || process.env.LOGNAME?.trim()
  const uid = process.getuid?.() ?? numericEnvironmentUid(process.env.UID)
  if (user === undefined || user.length === 0 || uid === undefined) {
    throw new SlurmError('dongfeng-slurm requires a POSIX user name and effective uid', 'SLURM_COMMAND_UNAVAILABLE')
  }
  const commands = await resolveSlurmCommands(ctx)
  const runtime = new DongfengSlurmRuntime(ctx, config, commands, user, uid)
  registerSlurmTools(ctx, config, runtime)
}

/**
 * Register all model-facing tools against one operations implementation.
 * Exported so unit tests can replace only the Slurm command boundary while
 * preserving the real tool registry and lifecycle.
 * @param ctx - Plugin context with the tool registry.
 * @param config - Validated deployment configuration.
 * @param runtime - Slurm operations implementation.
 */
export function registerSlurmTools(ctx: Context, config: Config, runtime: SlurmOperations): void {
  ctx.tools.register(defineTool({
    name: 'slurm_resources',
    description: 'Discover the current system user\'s authorized Slurm partitions, QOS values, and per-job CPU, memory, GPU, and wall-time limits. Returns the deployment defaults and allowed combinations.',
    parameters: {},
    isConcurrencySafe: () => true,
    timeoutMs: config.commandTimeoutMs,
    output: jsonOutput(RESOURCES_OUTPUT_SCHEMA, value => renderJson(value, config.workRoot)),
    execute: (_args, exec) => runtime.resources(exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Discover Slurm resources', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'slurm_submit',
    description: 'Submit one Slurm batch job as the current system user. Command mode creates a private script and accepts structured resources; script mode submits an existing .sbatch file without rewriting it or overriding its resources.',
    parameters: {
      request: {
        oneOf: [COMMAND_REQUEST_SCHEMA, SCRIPT_REQUEST_SCHEMA],
        required: true,
        description: 'Discriminated command or script submission request.',
      },
    },
    timeoutMs: config.commandTimeoutMs,
    output: jsonOutput(SUBMISSION_OUTPUT_SCHEMA, value => renderJson(value, config.workRoot)),
    execute: (args, exec) => runtime.submit(args.request as SlurmSubmitRequest, exec.signal),
    presentCall: args => ({ card: 'generic', title: args.request.type === 'command' ? `Submit Slurm job ${args.request.name}` : `Submit Slurm script ${args.request.scriptPath}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'slurm_list_jobs',
    description: 'List jobs owned by the current system user. Without since, returns active jobs; with an ISO timestamp, queries recent accounting history. Results are bounded by the deployment limit.',
    parameters: {
      since: { type: 'string', description: 'ISO timestamp for the earliest historical job.' },
      states: { type: 'array', items: { type: 'string' }, description: 'Optional normalized Slurm state filter.' },
      limit: { type: 'integer', description: 'Maximum records, bounded by deployment configuration.' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: config.commandTimeoutMs,
    output: jsonOutput({ type: 'array', items: JOB_OUTPUT_SCHEMA }, value => renderJson(value, config.workRoot)),
    execute: (args, exec) => runtime.listJobs(args, exec.signal),
    presentCall: () => ({ card: 'generic', title: 'List Slurm jobs', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'slurm_get_job',
    description: 'Get normalized status, queue reason, resources, nodes, exit status, and log paths for one Slurm job owned by the current system user.',
    parameters: { jobId: { type: 'string', required: true, description: 'Numeric Slurm job id.' } },
    isConcurrencySafe: () => true,
    timeoutMs: config.commandTimeoutMs,
    output: jsonOutput(JOB_OUTPUT_SCHEMA, value => renderJson(value, config.workRoot)),
    execute: (args, exec) => runtime.getJob(slurmJobId(args.jobId), exec.signal),
    presentCall: args => ({ card: 'generic', title: `Inspect Slurm job ${args.jobId}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'slurm_read_logs',
    description: 'Read a bounded tail of stdout, stderr, or both for one Slurm job owned by the current system user. Log files and resolved symlink targets must remain under the configured work root.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'Numeric Slurm job id.' },
      stream: { type: 'string', enum: ['stdout', 'stderr', 'both'], default: 'both', description: 'Which standard stream to read.' },
      maxBytes: { type: 'integer', description: 'Per-stream byte cap, bounded by deployment configuration.' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: config.commandTimeoutMs,
    output: jsonOutput(LOGS_OUTPUT_SCHEMA, value => renderJson(value, config.workRoot)),
    execute: (args, exec) => runtime.readLogs(slurmJobId(args.jobId), args.stream ?? 'both', args.maxBytes, exec.signal),
    presentCall: args => ({ card: 'generic', title: `Read Slurm job ${args.jobId} logs`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'slurm_cancel',
    description: 'Cancel one active Slurm job owned by the current system user. The deployment may require an explicit human approval before dispatch.',
    parameters: { jobId: { type: 'string', required: true, description: 'Numeric Slurm job id.' } },
    timeoutMs: config.commandTimeoutMs,
    output: jsonOutput(CANCEL_OUTPUT_SCHEMA, value => renderJson(value, config.workRoot)),
    execute: (args, exec) => runtime.cancel(slurmJobId(args.jobId), exec.signal),
    presentCall: args => ({ card: 'generic', title: `Cancel Slurm job ${args.jobId}`, kind: 'execute' }),
  }))

  if (config.cancelRequiresApproval) {
    ctx.on('tools/pre-execute', (exec, next) => exec.name === 'slurm_cancel'
      ? Promise.resolve({ kind: 'ask' as const, reason: `Cancel Slurm job ${(exec.arguments as { jobId?: unknown }).jobId ?? ''}?` })
      : next())
  }
}

function jsonOutput<const S extends ValueSchemaSpec>(schema: S, render: (value: JsonValue) => string) {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: render(toJsonValue(value)) }],
  }
}

function renderJson(value: JsonValue, workRoot: string): string {
  return JSON.stringify(relativizePaths(value, workRoot), null, 2)
}

function relativizePaths(value: JsonValue, workRoot: string): JsonValue {
  if (typeof value === 'string') {
    const normalizedRoot = workRoot.replaceAll('\\', '/')
    const normalized = value.replaceAll('\\', '/')
    return normalized === normalizedRoot
      ? '.'
      : normalized.startsWith(`${normalizedRoot}/`)
        ? `.${normalized.slice(normalizedRoot.length)}`
        : value
  }
  if (Array.isArray(value)) return value.map(item => relativizePaths(item, workRoot))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relativizePaths(item, workRoot)]))
}

function toJsonValue(value: unknown): JsonValue {
  const json = snapshotJsonValue(value)
  if (json === undefined) throw new Error('dongfeng-slurm produced a non-JSON result')
  return json as JsonValue
}

function validateConfig(config: Config): void {
  for (const [name, value] of Object.entries({
    commandTimeoutMs: config.commandTimeoutMs,
    logMaxBytes: config.logMaxBytes,
    listMaxItems: config.listMaxItems,
    rawOutputMaxBytes: config.rawOutputMaxBytes,
    graceMs: config.graceMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`dongfeng-slurm: ${name} must be a positive safe integer`)
  }
  for (const [name, value] of Object.entries({ workRoot: config.workRoot, defaultPartition: config.defaultPartition, defaultQos: config.defaultQos })) {
    if (value.trim().length === 0) throw new Error(`dongfeng-slurm: ${name} must be a non-empty string`)
  }
}

function numericEnvironmentUid(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined
  const uid = Number(value)
  return Number.isSafeInteger(uid) ? uid : undefined
}
