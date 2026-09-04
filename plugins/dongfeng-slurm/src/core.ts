/**
 * Dongfeng Slurm command adapter and domain normalization. The adapter owns
 * argv construction, bounded subprocess collection, Slurm JSON validation,
 * account limit checks, job ownership checks, and canonical path admission.
 * @module dsh-dongfeng-slurm-plugin/core
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** A Slurm job identifier admitted from `sbatch` or a tool argument. */
export type SlurmJobId = Branded<'SlurmJobId'>

/** Stable failure classes exposed by every Dongfeng Slurm tool. */
export type SlurmErrorCode =
  | 'SLURM_COMMAND_UNAVAILABLE'
  | 'SLURM_REJECTED'
  | 'SLURM_INVALID_RESPONSE'
  | 'SLURM_FORBIDDEN_PATH'
  | 'SLURM_RESOURCE_LIMIT'
  | 'SLURM_JOB_NOT_FOUND'
  | 'SLURM_JOB_NOT_OWNED'

/** A machine-routable Slurm plugin failure. */
export class SlurmError extends HarnessError {
  override readonly code: SlurmErrorCode

  /**
   * @param message - Operator- and model-readable failure description.
   * @param code - Stable plugin failure code.
   * @param options - Optional causal error.
   */
  constructor(message: string, code: SlurmErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** External commands resolved once in the filesystem/subprocess execution world. */
export type SlurmCommandName = 'sbatch' | 'squeue' | 'scontrol' | 'sacct' | 'sacctmgr' | 'sinfo' | 'scancel' | 'tail'

/** Canonical absolute paths for every external command the plugin invokes. */
export type SlurmCommands = Readonly<Record<SlurmCommandName, string>>

/** Resolved deployment values; defaults belong to the overlay, not this module. */
export interface SlurmRuntimeConfig {
  workRoot: string
  defaultPartition: string
  defaultQos: string
  commandTimeoutMs: number
  logMaxBytes: number
  listMaxItems: number
  cancelRequiresApproval: boolean
  rawOutputMaxBytes: number
  graceMs: number
}

/** Structured resource request accepted by command-mode submission. */
export interface SlurmResourceRequest {
  account?: string
  partition?: string
  qos?: string
  cpus?: number
  memoryMb?: number
  gpus?: number
  gpuType?: string
  timeMinutes?: number
}

/** Command-mode submission request. */
export interface SlurmCommandRequest extends SlurmResourceRequest {
  type: 'command'
  name: string
  command: string
  workdir?: string
}

/** Existing-script submission request. */
export interface SlurmScriptRequest {
  type: 'script'
  scriptPath: string
  workdir?: string
}

/** Submission request discriminated by source kind. */
export type SlurmSubmitRequest = SlurmCommandRequest | SlurmScriptRequest

/** Optional numeric limits for one partition/QOS combination. */
export interface SlurmLimits {
  cpus?: number
  memoryMb?: number
  gpus?: number
  timeMinutes?: number
}

/** One account-authorized partition/QOS combination. */
export interface SlurmResourceCombination {
  cluster: string
  account: string
  partition: string
  qos: string
  limits: SlurmLimits
}

/** Current user's normalized Slurm resource view. */
export interface SlurmResources {
  user: string
  defaultPartition: string
  defaultQos: string
  combinations: SlurmResourceCombination[]
  warnings: string[]
}

/** Resource settings passed to `sbatch` after defaults and account checks. */
export interface FinalSlurmResources {
  account: string
  partition: string
  qos: string
  cpus?: number
  memoryMb?: number
  gpus?: number
  gpuType?: string
  timeMinutes?: number
}

/** Successful submission details. */
export interface SlurmSubmission {
  jobId: SlurmJobId
  cluster?: string
  scriptPath: string
  workdir: string
  stdoutPath?: string
  stderrPath?: string
  resources?: FinalSlurmResources
}

/** A normalized Slurm job record. */
export interface SlurmJob {
  jobId: SlurmJobId
  name: string
  state: string
  reason?: string
  partition?: string
  qos?: string
  account?: string
  cluster?: string
  cpus?: number
  memoryMb?: number
  gpus?: number
  nodes: string[]
  exitCode?: string
  stdoutPath?: string
  stderrPath?: string
  submitTime?: string
  startTime?: string
  endTime?: string
  user: string
  uid: number
}

/** One bounded log stream result. */
export interface SlurmLogStream {
  path?: string
  text: string
  exists: boolean
  truncated: boolean
}

/** Successful cancellation or a race with terminal completion. */
export interface SlurmCancelResult {
  jobId: SlurmJobId
  outcome: 'cancelled' | 'already-finished'
  state?: string
}

interface CommandResult {
  stdout: string
  stderr: string
}

type JsonRecord = Record<string, unknown>

const TERMINAL_STATES = new Set([
  'BOOT_FAIL', 'CANCELLED', 'COMPLETED', 'DEADLINE', 'FAILED', 'NODE_FAIL',
  'OUT_OF_MEMORY', 'PREEMPTED', 'REVOKED', 'SPECIAL_EXIT', 'TIMEOUT',
])

/** Validate and brand a numeric Slurm job id. */
export function slurmJobId(value: string): SlurmJobId {
  if (!/^\d+$/u.test(value)) {
    throw new SlurmError(`invalid Slurm job id ${JSON.stringify(value)}`, 'SLURM_INVALID_RESPONSE')
  }
  return value as SlurmJobId
}

/** Resolve every required command and report the first missing executable at activation. */
export async function resolveSlurmCommands(ctx: Context, signal?: AbortSignal): Promise<SlurmCommands> {
  const names: SlurmCommandName[] = ['sbatch', 'squeue', 'scontrol', 'sacct', 'sacctmgr', 'sinfo', 'scancel', 'tail']
  const entries: [SlurmCommandName, string][] = []
  for (const command of names) {
    try {
      entries.push([command, await ctx.subprocess.resolveExecutable(command, undefined, signal)])
    } catch (error: unknown) {
      throw new SlurmError(`required command ${JSON.stringify(command)} is unavailable`, 'SLURM_COMMAND_UNAVAILABLE', { cause: error })
    }
  }
  return Object.fromEntries(entries) as unknown as SlurmCommands
}

/**
 * Per-user Slurm runtime. The instance carries no credentials and re-reads
 * associations and QOS limits before each command-mode submission.
 */
export class DongfengSlurmRuntime {
  private readonly rootPromise: Promise<FsTarget>

  /**
   * @param ctx - Plugin context with filesystem and subprocess providers.
   * @param config - Fully resolved deployment configuration.
   * @param commands - Activation-time executable paths.
   * @param user - Current operating-system username.
   * @param uid - Current effective operating-system uid.
   */
  constructor(
    private readonly ctx: Context,
    readonly config: SlurmRuntimeConfig,
    readonly commands: SlurmCommands,
    readonly user: string,
    readonly uid: number,
  ) {
    this.rootPromise = ctx.fs.resolve(config.workRoot)
  }

  /** Read current partitions, account associations, QOS permissions, and limits. */
  async resources(signal?: AbortSignal): Promise<SlurmResources> {
    const [associationResult, partitionResult] = await Promise.all([
      this.run('sacctmgr', ['--json', 'show', 'association', 'where', `user=${this.user}`, 'format=Cluster,Account,Partition,QOS,DefaultQOS'], this.config.workRoot, signal),
      this.run('sinfo', ['--json'], this.config.workRoot, signal),
    ])
    const associationJson = parseSlurmJson(associationResult.stdout, 'sacctmgr association')
    const partitionJson = parseSlurmJson(partitionResult.stdout, 'sinfo')
    const qosNames = authorizedQosNames(associationJson, this.user)
    const qosResult = qosNames.length === 0
      ? { stdout: '{"qos":[],"errors":[],"warnings":[]}', stderr: '' }
      : await this.run('sacctmgr', ['--json', 'show', 'qos', 'where', `name=${qosNames.join(',')}`, 'format=Name,MaxTRESPerJob,MaxWall'], this.config.workRoot, signal)
    const qosJson = parseSlurmJson(qosResult.stdout, 'sacctmgr qos')
    return normalizeResources(
      this.user,
      this.config.defaultPartition,
      this.config.defaultQos,
      associationJson,
      qosJson,
      partitionJson,
    )
  }

  /** Submit a generated command script or an existing `.sbatch` file. */
  async submit(request: SlurmSubmitRequest, signal?: AbortSignal): Promise<SlurmSubmission> {
    signal?.throwIfAborted()
    if (request.type === 'script') return this.submitScript(request, signal)
    return this.submitCommand(request, signal)
  }

  /** List active jobs, or recent accounting records when `since` is supplied. */
  async listJobs(options: { since?: string; states?: string[]; limit?: number }, signal?: AbortSignal): Promise<SlurmJob[]> {
    const limit = options.limit ?? this.config.listMaxItems
    assertPositiveInteger('limit', limit)
    if (limit > this.config.listMaxItems) {
      throw new SlurmError(`limit ${limit} exceeds configured maximum ${this.config.listMaxItems}`, 'SLURM_RESOURCE_LIMIT')
    }
    let result: CommandResult
    if (options.since === undefined) {
      result = await this.run('squeue', ['--json', '--user', this.user], this.config.workRoot, signal)
    } else {
      const since = parseIsoTime(options.since)
      const argv = ['--json', '--user', this.user, '--starttime', since]
      if (options.states !== undefined && options.states.length > 0) argv.push('--state', options.states.join(','))
      result = await this.run('sacct', argv, this.config.workRoot, signal)
    }
    const json = parseSlurmJson(result.stdout, options.since === undefined ? 'squeue' : 'sacct')
    const jobs = normalizeJobs(json)
      .filter(job => options.states === undefined || options.states.length === 0 || options.states.includes(job.state))
    for (const job of jobs) this.assertOwned(job)
    return jobs.slice(0, limit)
  }

  /** Return one current-user job from the live controller or accounting history. */
  async getJob(jobId: SlurmJobId, signal?: AbortSignal): Promise<SlurmJob> {
    let jobs: SlurmJob[] = []
    try {
      const live = await this.run('scontrol', ['show', 'job', '--json', jobId], this.config.workRoot, signal)
      jobs = normalizeJobs(parseSlurmJson(live.stdout, 'scontrol'))
    } catch (error: unknown) {
      if (!(error instanceof SlurmError) || error.code !== 'SLURM_REJECTED') throw error
    }
    let job = jobs.find(candidate => candidate.jobId === jobId)
    if (job === undefined) {
      const history = await this.run('sacct', ['--json', '--jobs', jobId, '--starttime', '1970-01-01'], this.config.workRoot, signal)
      job = normalizeJobs(parseSlurmJson(history.stdout, 'sacct'))
        .find(candidate => candidate.jobId === jobId)
    }
    if (job === undefined) throw new SlurmError(`Slurm job ${jobId} was not found`, 'SLURM_JOB_NOT_FOUND')
    this.assertOwned(job)
    return job
  }

  /** Read one or both standard streams as bounded tails. */
  async readLogs(jobId: SlurmJobId, stream: 'stdout' | 'stderr' | 'both', maxBytes: number | undefined, signal?: AbortSignal): Promise<{ stdout?: SlurmLogStream; stderr?: SlurmLogStream }> {
    const cap = maxBytes ?? this.config.logMaxBytes
    assertPositiveInteger('maxBytes', cap)
    if (cap > this.config.logMaxBytes) {
      throw new SlurmError(`maxBytes ${cap} exceeds configured maximum ${this.config.logMaxBytes}`, 'SLURM_RESOURCE_LIMIT')
    }
    const job = await this.getJob(jobId, signal)
    const result: { stdout?: SlurmLogStream; stderr?: SlurmLogStream } = {}
    if (stream === 'stdout' || stream === 'both') result.stdout = await this.readLogPath(job.stdoutPath, job, cap, signal)
    if (stream === 'stderr' || stream === 'both') result.stderr = await this.readLogPath(job.stderrPath, job, cap, signal)
    return result
  }

  /** Cancel an owned active job, with an explicit result for completion races. */
  async cancel(jobId: SlurmJobId, signal?: AbortSignal): Promise<SlurmCancelResult> {
    const before = await this.getJob(jobId, signal)
    if (TERMINAL_STATES.has(before.state)) return { jobId, outcome: 'already-finished', state: before.state }
    try {
      await this.run('scancel', ['--user', this.user, jobId], this.config.workRoot, signal)
      return { jobId, outcome: 'cancelled' }
    } catch (error: unknown) {
      if (!(error instanceof SlurmError) || error.code !== 'SLURM_REJECTED') throw error
      try {
        const after = await this.getJob(jobId, signal)
        if (TERMINAL_STATES.has(after.state)) return { jobId, outcome: 'already-finished', state: after.state }
      } catch (lookupError: unknown) {
        if (lookupError instanceof SlurmError && lookupError.code === 'SLURM_JOB_NOT_FOUND') {
          return { jobId, outcome: 'already-finished' }
        }
        throw lookupError
      }
      throw error
    }
  }

  private async submitCommand(request: SlurmCommandRequest, signal?: AbortSignal): Promise<SlurmSubmission> {
    const name = requiredText('name', request.name)
    const command = requiredText('command', request.command)
    const workdir = await this.resolveDirectory(request.workdir ?? this.config.workRoot, signal)
    const resources = await this.resolveResources(request, signal)
    const privateRoot = join(workdir, '.dsh-slurm')
    let privateRootEntry = await this.ctx.fs.lstat(privateRoot, undefined, signal)
    if (privateRootEntry?.type === 'symlink') {
      throw new SlurmError(`generated-script directory ${JSON.stringify(privateRoot)} must not be a symbolic link`, 'SLURM_FORBIDDEN_PATH')
    }
    if (privateRootEntry === undefined) {
      try {
        await mkdir(privateRoot, { mode: 0o700 })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      privateRootEntry = await this.ctx.fs.lstat(privateRoot, undefined, signal)
    }
    if (privateRootEntry?.type !== 'directory') {
      throw new SlurmError(`generated-script path ${JSON.stringify(privateRoot)} must be a directory`, 'SLURM_FORBIDDEN_PATH')
    }
    const privateRootTarget = await this.ctx.fs.resolve(privateRoot, signal === undefined ? undefined : { signal })
    await this.assertContained(privateRootTarget)
    const directory = join(privateRoot, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    const directoryTarget = await this.ctx.fs.resolve(directory, signal === undefined ? undefined : { signal })
    await this.assertContained(directoryTarget)
    const scriptPath = join(directory, 'job.sbatch')
    const stdoutPath = join(directory, 'stdout.log')
    const stderrPath = join(directory, 'stderr.log')
    const scriptTarget = await this.ctx.fs.resolve(scriptPath, signal === undefined ? undefined : { signal })
    await this.assertContained(scriptTarget)
    await writeFile(scriptPath, `#!/usr/bin/env bash\n${command}\n`, { flag: 'wx', mode: 0o600, ...signal === undefined ? {} : { signal } })
    const writtenTarget = await this.ctx.fs.resolve(scriptPath, signal === undefined ? undefined : { signal })
    await this.assertContained(writtenTarget)
    const writtenInfo = await this.ctx.fs.lstat(scriptPath, undefined, signal)
    if (writtenInfo?.type !== 'file') {
      throw new SlurmError(`generated script ${JSON.stringify(scriptPath)} is not a regular file`, 'SLURM_FORBIDDEN_PATH')
    }
    const argv = this.submitArgv(scriptPath, workdir, name, stdoutPath, stderrPath, resources)
    const result = await this.run('sbatch', argv, workdir, signal)
    const parsed = parseSbatchParsable(result.stdout)
    return {
      ...parsed,
      scriptPath,
      workdir,
      stdoutPath,
      stderrPath,
      resources,
    }
  }

  private async submitScript(request: SlurmScriptRequest, signal?: AbortSignal): Promise<SlurmSubmission> {
    const scriptPath = await this.resolveScript(request.scriptPath, signal)
    const workdir = await this.resolveDirectory(request.workdir ?? this.config.workRoot, signal)
    const result = await this.run('sbatch', ['--parsable', '--chdir', workdir, scriptPath], workdir, signal)
    return { ...parseSbatchParsable(result.stdout), scriptPath, workdir }
  }

  private async resolveResources(request: SlurmResourceRequest, signal?: AbortSignal): Promise<FinalSlurmResources> {
    validateOptionalPositiveInteger('cpus', request.cpus)
    validateOptionalPositiveInteger('memoryMb', request.memoryMb)
    validateOptionalPositiveInteger('gpus', request.gpus)
    validateOptionalPositiveInteger('timeMinutes', request.timeMinutes)
    if (request.gpuType !== undefined) requiredText('gpuType', request.gpuType)
    const partition = requiredText('partition', request.partition ?? this.config.defaultPartition)
    const qos = requiredText('qos', request.qos ?? this.config.defaultQos)
    const requestedAccount = request.account === undefined ? undefined : requiredText('account', request.account)
    const available = await this.resources(signal)
    const combinations = available.combinations.filter(item => item.partition === partition && item.qos === qos && (requestedAccount === undefined || item.account === requestedAccount))
    if (combinations.length === 0) {
      const accountDetail = requestedAccount === undefined ? '' : ` and account ${JSON.stringify(requestedAccount)}`
      throw new SlurmError(`partition ${JSON.stringify(partition)} with QOS ${JSON.stringify(qos)}${accountDetail} is not authorized for ${this.user}`, 'SLURM_RESOURCE_LIMIT')
    }
    const accounts = new Set(combinations.map(item => item.account))
    if (requestedAccount === undefined && accounts.size > 1) {
      throw new SlurmError(`partition ${JSON.stringify(partition)} with QOS ${JSON.stringify(qos)} is authorized through multiple accounts; specify account`, 'SLURM_RESOURCE_LIMIT')
    }
    const combination = combinations[0]
    if (combination === undefined) throw new SlurmError('Slurm resource selection failed', 'SLURM_INVALID_RESPONSE')
    checkLimit('cpus', request.cpus, combination.limits.cpus)
    checkLimit('memoryMb', request.memoryMb, combination.limits.memoryMb)
    checkLimit('gpus', request.gpus, combination.limits.gpus)
    checkLimit('timeMinutes', request.timeMinutes, combination.limits.timeMinutes)
    return {
      account: combination.account,
      partition,
      qos,
      ...request.cpus !== undefined ? { cpus: request.cpus } : {},
      ...request.memoryMb !== undefined ? { memoryMb: request.memoryMb } : {},
      ...request.gpus !== undefined ? { gpus: request.gpus } : {},
      ...request.gpuType !== undefined ? { gpuType: request.gpuType } : {},
      ...request.timeMinutes !== undefined ? { timeMinutes: request.timeMinutes } : {},
    }
  }

  private submitArgv(scriptPath: string, workdir: string, name: string, stdoutPath: string, stderrPath: string, resources: FinalSlurmResources): string[] {
    const argv = [
      '--parsable', '--job-name', name, '--chdir', workdir,
      '--account', resources.account, '--partition', resources.partition, '--qos', resources.qos,
      '--output', stdoutPath, '--error', stderrPath,
    ]
    if (resources.cpus !== undefined) argv.push('--cpus-per-task', String(resources.cpus))
    if (resources.memoryMb !== undefined) argv.push('--mem', `${resources.memoryMb}M`)
    if (resources.gpus !== undefined) {
      const resource = resources.gpuType === undefined
        ? `gpu:${resources.gpus}`
        : `gpu:${resources.gpuType}:${resources.gpus}`
      argv.push('--gres', resource)
    }
    if (resources.timeMinutes !== undefined) argv.push('--time', String(resources.timeMinutes))
    argv.push(scriptPath)
    return argv
  }

  private async resolveDirectory(path: string, signal?: AbortSignal): Promise<string> {
    const target = await this.ctx.fs.resolve(path, { cwd: this.config.workRoot, ...signal === undefined ? {} : { signal } })
    await this.assertContained(target)
    const info = await this.ctx.fs.stat(target, signal)
    if (info?.type !== 'directory') {
      throw new SlurmError(`working directory ${JSON.stringify(path)} is not an existing directory`, 'SLURM_FORBIDDEN_PATH')
    }
    return this.ctx.fs.processPath(target)
  }

  private async resolveScript(path: string, signal?: AbortSignal): Promise<string> {
    if (extname(path) !== '.sbatch') {
      throw new SlurmError(`script ${JSON.stringify(path)} must have the .sbatch extension`, 'SLURM_FORBIDDEN_PATH')
    }
    const direct = await this.ctx.fs.lstat(path, { cwd: this.config.workRoot }, signal)
    if (direct?.type === 'symlink') {
      throw new SlurmError(`script ${JSON.stringify(path)} must not be a symbolic link`, 'SLURM_FORBIDDEN_PATH')
    }
    const target = await this.ctx.fs.resolve(path, { cwd: this.config.workRoot, ...signal === undefined ? {} : { signal } })
    await this.assertContained(target)
    const info = await this.ctx.fs.stat(target, signal)
    if (info?.type !== 'file') {
      throw new SlurmError(`script ${JSON.stringify(path)} is not an existing regular file`, 'SLURM_FORBIDDEN_PATH')
    }
    return this.ctx.fs.processPath(target)
  }

  private async assertContained(target: FsTarget): Promise<void> {
    const root = await this.rootPromise
    const rootInfo = await this.ctx.fs.stat(root)
    if (rootInfo?.type !== 'directory') {
      throw new SlurmError(`configured work root ${JSON.stringify(this.config.workRoot)} is not an existing directory`, 'SLURM_FORBIDDEN_PATH')
    }
    if (!this.ctx.fs.contains(root, target)) {
      throw new SlurmError(`path ${JSON.stringify(target.displayPath)} escapes configured work root`, 'SLURM_FORBIDDEN_PATH')
    }
  }

  private assertOwned(job: SlurmJob): void {
    if (job.uid !== this.uid || job.user !== this.user) {
      throw new SlurmError(`Slurm job ${job.jobId} is not owned by current user ${this.user}`, 'SLURM_JOB_NOT_OWNED')
    }
  }

  private async readLogPath(path: string | undefined, job: SlurmJob, maxBytes: number, signal?: AbortSignal): Promise<SlurmLogStream> {
    if (path === undefined || path.length === 0) return { text: '', exists: false, truncated: false }
    const expanded = expandSlurmPath(path, job)
    const direct = await this.ctx.fs.lstat(expanded, { cwd: this.config.workRoot }, signal)
    if (direct === undefined) return { path: expanded, text: '', exists: false, truncated: false }
    if (direct.type === 'symlink') {
      throw new SlurmError(`log path ${JSON.stringify(expanded)} must not be a symbolic link`, 'SLURM_FORBIDDEN_PATH')
    }
    const target = await this.ctx.fs.resolve(expanded, { cwd: this.config.workRoot, ...signal === undefined ? {} : { signal } })
    await this.assertContained(target)
    const info = await this.ctx.fs.stat(target, signal)
    if (info?.type !== 'file') {
      throw new SlurmError(`log path ${JSON.stringify(expanded)} is not a regular file`, 'SLURM_FORBIDDEN_PATH')
    }
    const processPath = this.ctx.fs.processPath(target)
    const result = await this.run('tail', ['-c', String(maxBytes), '--', processPath], this.config.workRoot, signal, maxBytes)
    return {
      path: processPath,
      text: result.stdout,
      exists: true,
      truncated: info.size !== undefined && info.size > maxBytes,
    }
  }

  private async run(command: SlurmCommandName, args: string[], cwd: string, signal?: AbortSignal, stdoutCap = this.config.rawOutputMaxBytes): Promise<CommandResult> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error(`${command} timed out`)), this.config.commandTimeoutMs)
    const fused = fuseSignals(signal, deadline.signal)
    const handle = this.ctx.subprocess.spawn({
      argv: [this.commands[command], ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: stdoutCap },
        stderr: { maxBytes: this.config.logMaxBytes },
      },
      graceMs: this.config.graceMs,
      signal: fused.signal,
    })
    try {
      const outcome = await handle.done
      await handle.waitForExit()
      const stdout = readCollected(handle.collected.stdout, command, 'stdout')
      const stderr = readCollected(handle.collected.stderr, command, 'stderr', true)
      if (fused.signal.aborted) {
        throw new SlurmError(`${command} was cancelled or timed out`, 'SLURM_REJECTED', { cause: fused.signal.reason })
      }
      if (outcome.exitCode !== 0) {
        const detail = stderr.trim().length === 0 ? `exit ${String(outcome.exitCode)}` : stderr.trim()
        throw new SlurmError(`${command} rejected the request: ${detail}`, 'SLURM_REJECTED')
      }
      return { stdout, stderr }
    } catch (error: unknown) {
      await handle.waitForExit()
      if (error instanceof SlurmError) throw error
      throw new SlurmError(`${command} could not run`, 'SLURM_REJECTED', { cause: error })
    } finally {
      clearTimeout(timer)
      fused.dispose()
    }
  }
}

/** Parse `sbatch --parsable` output in `jobid` or `jobid;cluster` form. */
export function parseSbatchParsable(stdout: string): { jobId: SlurmJobId; cluster?: string } {
  const line = stdout.trim()
  const [job, cluster, extra] = line.split(';')
  if (job === undefined || extra !== undefined || !/^\d+$/u.test(job) || (cluster !== undefined && cluster.length === 0)) {
    throw new SlurmError(`sbatch returned invalid parsable output ${JSON.stringify(line)}`, 'SLURM_INVALID_RESPONSE')
  }
  return { jobId: slurmJobId(job), ...cluster !== undefined ? { cluster } : {} }
}

/** Parse one Slurm JSON document and reject top-level protocol errors. */
export function parseSlurmJson(text: string, source: string): JsonRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new SlurmError(`${source} returned malformed JSON`, 'SLURM_INVALID_RESPONSE', { cause: error })
  }
  if (!isRecord(parsed)) throw new SlurmError(`${source} returned a non-object JSON document`, 'SLURM_INVALID_RESPONSE')
  const errors = Array.isArray(parsed.errors) ? parsed.errors : []
  if (errors.length > 0) {
    throw new SlurmError(`${source} reported errors: ${errors.map(renderSlurmMessage).join('; ')}`, 'SLURM_REJECTED')
  }
  return parsed
}

/** Normalize resource JSON returned by `sacctmgr` and `sinfo`. */
export function normalizeResources(user: string, defaultPartition: string, defaultQos: string, associationsJson: JsonRecord, qosJson: JsonRecord, partitionsJson: JsonRecord): SlurmResources {
  const associations = arrayField(associationsJson, ['associations', 'association'])
  const qosRows = arrayField(qosJson, ['qos'])
  const partitionRows = arrayField(partitionsJson, ['sinfo', 'partitions', 'partition'])
  const partitionRecords = new Map<string, JsonRecord>()
  for (const row of partitionRows) {
    const partition = recordField(row, ['partition']) ?? row
    const name = textField(partition, ['name', 'partition'])
    if (name !== undefined) partitionRecords.set(name, partition)
  }
  const partitionNames = [...partitionRecords.keys()]
  const qosLimits = new Map<string, SlurmLimits>()
  for (const row of qosRows) {
    const name = textField(row, ['name', 'qos'])
    if (name === undefined) continue
    const flatTres = parseTresLimits(textField(row, ['max_tres_per_job', 'max_tres', 'tres']))
    const jobTres = parseTresEntries(pathValue(row, ['limits', 'max', 'tres', 'per', 'job']))
    const userTres = parseTresEntries(pathValue(row, ['limits', 'max', 'tres', 'per', 'user']))
    const resourceLimits = minimumLimits(flatTres, jobTres, userTres)
    const flatTime = durationMinutes(valueField(row, ['max_wall_minutes', 'max_wall', 'maxwall']))
    const nestedTime = limitNumber(pathValue(row, ['limits', 'max', 'wall_clock', 'per', 'job']))
    const timeMinutes = minimumDefined(flatTime, nestedTime)
    qosLimits.set(name, { ...resourceLimits, ...timeMinutes === undefined ? {} : { timeMinutes } })
  }
  const combinations: SlurmResourceCombination[] = []
  for (const association of associations) {
    const account = textField(association, ['account']) ?? ''
    const cluster = textField(association, ['cluster']) ?? ''
    const associatedUser = textField(association, ['user', 'user_name'])
    if (associatedUser !== undefined && associatedUser !== user) continue
    const associatedPartitions = stringList(valueField(association, ['partition', 'partitions']))
    const authorizedPartitions = associatedPartitions.length > 0 ? associatedPartitions : partitionNames
    const qosNames = stringList(valueField(association, ['qos', 'qos_list', 'qos_names']))
    for (const partition of authorizedPartitions) {
      const partitionRecord = partitionRecords.get(partition)
      const allowedAccounts = stringList(pathValue(partitionRecord, ['accounts', 'allowed']))
      const deniedAccounts = stringList(pathValue(partitionRecord, ['accounts', 'deny']))
      if (allowedAccounts.length > 0 && !allowedAccounts.includes(account)) continue
      if (deniedAccounts.includes(account)) continue
      const allowedQos = stringList(pathValue(partitionRecord, ['qos', 'allowed']))
      const deniedQos = stringList(pathValue(partitionRecord, ['qos', 'deny']))
      for (const qos of qosNames) {
        if (allowedQos.length > 0 && !allowedQos.includes(qos)) continue
        if (deniedQos.includes(qos)) continue
        combinations.push({ cluster, account, partition, qos, limits: qosLimits.get(qos) ?? {} })
      }
    }
  }
  const unique = new Map(combinations.map(item => [`${item.cluster}\0${item.account}\0${item.partition}\0${item.qos}`, item]))
  const normalizedCombinations = [...unique.values()].sort((a, b) => a.partition.localeCompare(b.partition) || a.qos.localeCompare(b.qos))
  const warnings = [
    ...messageList(associationsJson.warnings),
    ...messageList(qosJson.warnings),
    ...messageList(partitionsJson.warnings),
  ]
  if (!normalizedCombinations.some(item => item.partition === defaultPartition && item.qos === defaultQos)) {
    warnings.push(`configured default partition ${JSON.stringify(defaultPartition)} with QOS ${JSON.stringify(defaultQos)} is not currently authorized`)
  }
  return {
    user,
    defaultPartition,
    defaultQos,
    combinations: normalizedCombinations,
    warnings,
  }
}

/** Return the current user's distinct QOS names from association JSON. */
export function authorizedQosNames(json: JsonRecord, user: string): string[] {
  const names = new Set<string>()
  for (const association of arrayField(json, ['associations', 'association'])) {
    const associatedUser = textField(association, ['user', 'user_name'])
    if (associatedUser !== undefined && associatedUser !== user) continue
    for (const qos of stringList(valueField(association, ['qos', 'qos_list', 'qos_names']))) names.add(qos)
  }
  return [...names].sort()
}

/** Normalize live or accounting JSON into one stable job vocabulary. */
export function normalizeJobs(json: JsonRecord): SlurmJob[] {
  const rows = arrayField(json, ['jobs', 'job_records', 'records'])
  return rows.map((row) => {
    const rawId = textField(row, ['job_id', 'jobid', 'id'])
    if (rawId === undefined) throw new SlurmError('Slurm job record is missing job_id', 'SLURM_INVALID_RESPONSE')
    const baseId = rawId.split('.')[0]
    if (baseId === undefined) throw new SlurmError('Slurm job record has an invalid job_id', 'SLURM_INVALID_RESPONSE')
    const uid = numberField(row, ['user_id', 'uid'])
    const user = textField(row, ['user_name', 'user'])
    if (uid === undefined || user === undefined) {
      throw new SlurmError(`Slurm job ${rawId} is missing owner uid or username`, 'SLURM_INVALID_RESPONSE')
    }
    return {
      jobId: slurmJobId(baseId),
      name: textField(row, ['name', 'job_name']) ?? '',
      state: (stringList(valueField(row, ['job_state', 'state']))[0] ?? 'UNKNOWN').toUpperCase(),
      ...optionalText(row, 'reason', ['state_reason', 'reason']),
      ...optionalText(row, 'partition', ['partition']),
      ...optionalText(row, 'qos', ['qos']),
      ...optionalText(row, 'account', ['account']),
      ...optionalText(row, 'cluster', ['cluster']),
      ...optionalNumber(row, 'cpus', ['cpus', 'cpus_requested', 'num_cpus']),
      ...optionalNumber(row, 'memoryMb', ['memory_mb', 'memory_per_node', 'memory']),
      ...optionalNumber(row, 'gpus', ['gpus', 'gpu_count']),
      ...optionalTresGpu(row),
      nodes: stringList(valueField(row, ['nodes', 'nodes_allocated', 'node_list'])),
      ...optionalExitCode(row),
      ...optionalText(row, 'stdoutPath', ['standard_output', 'stdout', 'stdout_path']),
      ...optionalText(row, 'stderrPath', ['standard_error', 'stderr', 'stderr_path']),
      ...optionalTime(row, 'submitTime', ['submit_time', 'submit']),
      ...optionalTime(row, 'startTime', ['start_time', 'start']),
      ...optionalTime(row, 'endTime', ['end_time', 'end']),
      user,
      uid,
    }
  })
}

/** Expand the stable subset of Slurm filename substitutions used by log paths. */
export function expandSlurmPath(path: string, job: SlurmJob): string {
  return path
    .replaceAll('%j', job.jobId)
    .replaceAll('%A', job.jobId)
    .replaceAll('%x', job.name)
    .replaceAll('%u', job.user)
}

function readCollected(reader: SubprocessOutputReader | undefined, command: string, stream: string, allowLoss = false): string {
  if (reader === undefined) throw new SlurmError(`${command} did not provide collected ${stream}`, 'SLURM_INVALID_RESPONSE')
  const output = reader.readFrom(0)
  if (output.lossy && !allowLoss) throw new SlurmError(`${command} ${stream} exceeded its configured output limit`, 'SLURM_INVALID_RESPONSE')
  return output.text
}

function fuseSignals(first: AbortSignal | undefined, second: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (first === undefined) return { signal: second, dispose() {} }
  const controller = new AbortController()
  const abortFirst = (): void => controller.abort(first.reason)
  const abortSecond = (): void => controller.abort(second.reason)
  if (first.aborted) abortFirst()
  else first.addEventListener('abort', abortFirst, { once: true })
  if (second.aborted) abortSecond()
  else second.addEventListener('abort', abortSecond, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      first.removeEventListener('abort', abortFirst)
      second.removeEventListener('abort', abortSecond)
    },
  }
}

function parseIsoTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new SlurmError(`since must be an ISO timestamp, received ${JSON.stringify(value)}`, 'SLURM_INVALID_RESPONSE')
  return date.toISOString()
}

function requiredText(name: string, value: string): string {
  if (value.trim().length === 0) throw new SlurmError(`${name} must be a non-empty string`, 'SLURM_INVALID_RESPONSE')
  return value
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new SlurmError(`${name} must be a positive safe integer`, 'SLURM_INVALID_RESPONSE')
}

function validateOptionalPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined) assertPositiveInteger(name, value)
}

function checkLimit(name: string, requested: number | undefined, maximum: number | undefined): void {
  if (requested !== undefined && maximum !== undefined && requested > maximum) {
    throw new SlurmError(`${name} request ${requested} exceeds current account limit ${maximum}`, 'SLURM_RESOURCE_LIMIT')
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayField(record: JsonRecord, names: string[]): JsonRecord[] {
  for (const name of names) {
    const value = record[name]
    if (Array.isArray(value)) return value.filter(isRecord)
  }
  return []
}

function valueField(record: JsonRecord, names: string[]): unknown {
  for (const name of names) {
    if (name in record) return unwrap(record[name])
  }
  return undefined
}

function recordField(record: JsonRecord, names: string[]): JsonRecord | undefined {
  for (const name of names) {
    const value = record[name]
    if (isRecord(value)) return value
  }
  return undefined
}

function pathValue(record: JsonRecord | undefined, path: string[]): unknown {
  let value: unknown = record
  for (const key of path) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return value
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.set === false) return undefined
  for (const key of ['string', 'number', 'value', 'name']) {
    if (key in value && value[key] !== null) return value[key]
  }
  return value
}

function textField(record: JsonRecord, names: string[]): string | undefined {
  const value = valueField(record, names)
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function numberField(record: JsonRecord, names: string[]): number | undefined {
  const value = valueField(record, names)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function optionalText<K extends string>(record: JsonRecord, key: K, names: string[]): { [P in K]?: string } {
  const value = textField(record, names)
  return value === undefined ? {} : { [key]: value } as { [P in K]?: string }
}

function optionalNumber<K extends string>(record: JsonRecord, key: K, names: string[]): { [P in K]?: number } {
  const value = numberField(record, names)
  return value === undefined ? {} : { [key]: value } as { [P in K]?: number }
}

function optionalTresGpu(record: JsonRecord): { gpus?: number } {
  if (numberField(record, ['gpus', 'gpu_count']) !== undefined) return {}
  return optionalLimit('gpus', parseTresLimits(textField(record, ['tres_req_str', 'tres_alloc_str'])).gpus)
}

function optionalExitCode(record: JsonRecord): { exitCode?: string } {
  const value = valueField(record, ['exit_code', 'derived_exit_code'])
  if (typeof value === 'string' || typeof value === 'number') return { exitCode: String(value) }
  if (!isRecord(value)) return {}
  const returnCode = limitNumber(value.return_code)
  const signal = limitNumber(pathValue(value, ['signal', 'id']))
  if (returnCode === undefined && signal === undefined) return {}
  return { exitCode: `${returnCode ?? 0}:${signal ?? 0}` }
}

function optionalTime<K extends string>(record: JsonRecord, key: K, names: string[]): { [P in K]?: string } {
  const value = valueField(record, names)
  if (typeof value === 'string' && value.length > 0) return { [key]: value } as { [P in K]?: string }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return {}
  return { [key]: new Date(value * 1000).toISOString() } as { [P in K]?: string }
}

function optionalLimit<K extends keyof SlurmLimits>(key: K, value: SlurmLimits[K]): { [P in K]?: number } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: number }
}

function stringList(value: unknown): string[] {
  const unwrapped = unwrap(value)
  if (Array.isArray(unwrapped)) return unwrapped.flatMap(item => stringList(item))
  if (typeof unwrapped !== 'string') return []
  return unwrapped.split(/[,:\s]+/u).map(item => item.trim()).filter(Boolean)
}

function parseTresLimits(value: string | undefined): SlurmLimits {
  if (value === undefined) return {}
  const limits: SlurmLimits = {}
  for (const token of value.split(',')) {
    const [rawName, rawValue] = token.split('=')
    if (rawName === undefined || rawValue === undefined) continue
    const number = parseSlurmQuantity(rawValue)
    if (number === undefined) continue
    const name = rawName.toLowerCase()
    if (name === 'cpu') limits.cpus = number
    else if (name === 'mem') limits.memoryMb = number
    else if (name === 'gres/gpu' || name === 'gpu') limits.gpus = number
  }
  return limits
}

function parseTresEntries(value: unknown): SlurmLimits {
  if (!Array.isArray(value)) return {}
  const limits: SlurmLimits = {}
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const count = numberField(entry, ['count'])
    const type = textField(entry, ['type'])?.toLowerCase()
    const name = textField(entry, ['name'])?.toLowerCase()
    if (count === undefined) continue
    if (type === 'cpu') limits.cpus = count
    else if (type === 'mem') limits.memoryMb = count
    else if ((type === 'gres' && name === 'gpu') || type === 'gpu') limits.gpus = count
  }
  return limits
}

function minimumLimits(...values: SlurmLimits[]): SlurmLimits {
  const result: SlurmLimits = {}
  for (const key of ['cpus', 'memoryMb', 'gpus', 'timeMinutes'] as const) {
    const limit = values.reduce<number | undefined>((minimum, value) => minimumDefined(minimum, value[key]), undefined)
    if (limit !== undefined) result[key] = limit
  }
  return result
}

function minimumDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return Math.min(first, second)
}

function limitNumber(value: unknown): number | undefined {
  const unwrapped = unwrap(value)
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return Math.floor(unwrapped)
  if (typeof unwrapped === 'string' && /^\d+$/u.test(unwrapped)) return Number(unwrapped)
  return undefined
}

function parseSlurmQuantity(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([kmgt]?)$/iu.exec(value.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = match[2]?.toUpperCase() ?? ''
  const multiplier = unit === 'K' ? 1 / 1024 : unit === 'M' || unit === '' ? 1 : unit === 'G' ? 1024 : unit === 'T' ? 1024 * 1024 : undefined
  return multiplier === undefined ? undefined : Math.floor(amount * multiplier)
}

function durationMinutes(value: unknown): number | undefined {
  const unwrapped = unwrap(value)
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return Math.floor(unwrapped)
  if (typeof unwrapped !== 'string') return undefined
  if (/^\d+$/u.test(unwrapped)) return Number(unwrapped)
  const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/u.exec(unwrapped)
  if (match === null) return undefined
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  const seconds = Number(match[4] ?? 0)
  return days * 1440 + hours * 60 + minutes + Math.ceil(seconds / 60)
}

function renderSlurmMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (isRecord(value)) return textField(value, ['description', 'message', 'error']) ?? JSON.stringify(value)
  return String(value)
}

function messageList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(renderSlurmMessage) : []
}
