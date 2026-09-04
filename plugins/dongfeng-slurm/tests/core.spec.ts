/** Dongfeng Slurm domain tests over a scriptable subprocess boundary and private filesystem roots. */

import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import {
  DongfengSlurmRuntime,
  normalizeJobs,
  normalizeResources,
  parseSbatchParsable,
  parseSlurmJson,
  resolveSlurmCommands,
  slurmJobId,
} from '../src/core.ts'
import type { SlurmCommands, SlurmRuntimeConfig } from '../src/core.ts'

interface ScriptedCommand {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stdoutLossy?: boolean
  reject?: Error
  done?: Promise<SubprocessOutcome>
  waitForExit?: () => Promise<boolean>
}

class FakeReader implements SubprocessOutputReader {
  constructor(private readonly text: string, private readonly lossy = false) {}

  readFrom(_fromByte: number): SubprocessOutputRead {
    return { text: this.text, nextOffset: Buffer.byteLength(this.text), lossy: this.lossy }
  }
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 42
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminated = false
  waitCount = 0

  constructor(spec: SubprocessSpawnSpec, private readonly script: ScriptedCommand) {
    this.collected = {
      stdout: new FakeReader(script.stdout ?? '', script.stdoutLossy),
      stderr: new FakeReader(script.stderr ?? ''),
    }
    this.done = script.done ?? (script.reject === undefined
      ? Promise.resolve({ exitCode: script.exitCode ?? 0, signal: script.signal ?? null })
      : Promise.reject(script.reject))
    spec.signal?.addEventListener('abort', () => { this.terminated = true }, { once: true })
  }

  terminate(): void { this.terminated = true }
  waitForExit(): Promise<boolean> { this.waitCount += 1; return this.script.waitForExit?.() ?? Promise.resolve(true) }
}

class FakeSubprocess extends SubprocessRuntime {
  readonly spawns: SubprocessSpawnSpec[] = []
  readonly handles: FakeHandle[] = []
  handler: (spec: SubprocessSpawnSpec) => ScriptedCommand = () => ({})
  missing?: string

  override resolveExecutable(command: string): Promise<string> {
    return command === this.missing ? Promise.reject(new Error('missing')) : Promise.resolve(`/usr/bin/${command}`)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const handle = new FakeHandle(spec, this.handler(spec))
    this.handles.push(handle)
    return handle
  }

  override spawnTerminal(): Promise<never> { return Promise.reject(new Error('not used')) }
}

const config = (root: string): SlurmRuntimeConfig => ({
  workRoot: root,
  defaultPartition: 'Students',
  defaultQos: 'qos_stu_default',
  commandTimeoutMs: 15_000,
  logMaxBytes: 65_536,
  listMaxItems: 100,
  cancelRequiresApproval: true,
  rawOutputMaxBytes: 1_048_576,
  graceMs: 3000,
})

const commands: SlurmCommands = {
  sbatch: '/usr/bin/sbatch',
  squeue: '/usr/bin/squeue',
  scontrol: '/usr/bin/scontrol',
  sacct: '/usr/bin/sacct',
  sacctmgr: '/usr/bin/sacctmgr',
  sinfo: '/usr/bin/sinfo',
  scancel: '/usr/bin/scancel',
  tail: '/usr/bin/tail',
}

const associations = JSON.stringify({
  associations: [{ cluster: 'training', account: 'competition', user: 'alice', partition: '', default: { qos: 'qos_stu_default' }, qos: ['qos_stu_default'] }],
  warnings: [],
  errors: [],
})
const qos = JSON.stringify({
  qos: [{
    name: 'qos_stu_default',
    limits: {
      max: {
        tres: {
          per: {
            job: [],
            user: [
              { type: 'cpu', name: '', id: 1, count: 4 },
              { type: 'mem', name: '', id: 2, count: 16_384 },
              { type: 'gres', name: 'gpu', id: 1001, count: 1 },
            ],
          },
        },
        wall_clock: { per: { job: { set: true, infinite: false, number: 240 } } },
      },
    },
  }],
  warnings: [],
  errors: [],
})
const partitions = JSON.stringify({
  sinfo: [{ partition: { name: 'Students', qos: { allowed: 'qos_stu_default', deny: '' } } }],
  warnings: [],
  errors: [],
})

function job(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jobs: [{
      job_id: 123,
      user_id: 1000,
      user_name: 'alice',
      name: 'sample',
      job_state: 'RUNNING',
      standard_output: join(root, 'stdout.log'),
      standard_error: join(root, 'stderr.log'),
      ...overrides,
    }],
    warnings: [],
    errors: [],
  })
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dongfeng-slurm-'))
  await mkdir(join(root, 'project'))
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(FakeSubprocess)
  const subprocess = ctx.subprocess as FakeSubprocess
  const runtime = new DongfengSlurmRuntime(ctx, config(root), commands, 'alice', 1000)
  return { root, ctx, subprocess, runtime }
}

function commandName(spec: SubprocessSpawnSpec): string {
  return spec.argv[0]?.split(/[\\/]/u).at(-1) ?? ''
}

function resourceHandler(spec: SubprocessSpawnSpec): ScriptedCommand {
  const command = commandName(spec)
  if (command === 'sinfo') return { stdout: partitions }
  if (command === 'sacctmgr' && spec.argv.includes('association')) return { stdout: associations }
  if (command === 'sacctmgr') return { stdout: qos }
  return {}
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Slurm response normalization', () => {
  it('parses Slurm 25.11 resource JSON and per-job limits', () => {
    const value = normalizeResources('alice', 'Students', 'qos_stu_default', parseSlurmJson(associations, 'associations'), parseSlurmJson(qos, 'qos'), parseSlurmJson(partitions, 'sinfo'))
    expect(value.combinations).toEqual([{
      cluster: 'training', account: 'competition', partition: 'Students', qos: 'qos_stu_default',
      limits: { cpus: 4, memoryMb: 16_384, gpus: 1, timeMinutes: 240 },
    }])
  })

  it('parses jobid and jobid;cluster output', () => {
    expect(parseSbatchParsable('123\n')).toEqual({ jobId: '123' })
    expect(parseSbatchParsable('456;training\n')).toEqual({ jobId: '456', cluster: 'training' })
    expect(() => parseSbatchParsable('oops')).toThrowError(expect.objectContaining({ code: 'SLURM_INVALID_RESPONSE' }))
  })

  it('intersects account associations with partition account and QOS allow-lists', () => {
    const value = normalizeResources(
      'alice',
      'Students',
      'qos_stu_default',
      { associations: [{ cluster: 'training', account: 'competition', user: 'alice', partition: '', qos: ['qos_stu_default', 'qos_p107-rtx5090'] }] },
      {
        qos: [
          { name: 'qos_stu_default', limits: { max: { tres: { per: { user: [{ type: 'cpu', name: '', count: 4 }] } } } } },
          { name: 'qos_p107-rtx5090', limits: { max: { tres: { per: { user: [{ type: 'cpu', name: '', count: 16 }, { type: 'gres', name: 'gpu', count: 4 }] } } } } },
        ],
      },
      {
        sinfo: [
          { partition: { name: 'Students', accounts: { allowed: 'stu' }, qos: { allowed: 'qos_stu_default' } } },
          { partition: { name: 'P107-RTX5090', accounts: { allowed: 'competition' }, qos: { allowed: 'qos_p107-rtx5090' } } },
        ],
      },
    )
    expect(value.combinations).toEqual([{
      cluster: 'training', account: 'competition', partition: 'P107-RTX5090', qos: 'qos_p107-rtx5090', limits: { cpus: 16, gpus: 4 },
    }])
    expect(value.warnings).toEqual([expect.stringContaining('configured default partition')])
  })

  it('normalizes Slurm 25.11 wrapped state, exit, time, CPU, and GPU fields', () => {
    const [value] = normalizeJobs({
      jobs: [{
        job_id: 53697,
        user_id: 68422,
        user_name: 'alice',
        name: 'sample',
        job_state: ['COMPLETED'],
        cpus: { set: true, infinite: false, number: 1 },
        tres_req_str: 'billing=1,cpu=1,gres/gpu=2,mem=64M,node=1',
        exit_code: {
          return_code: { set: true, infinite: false, number: 0 },
          signal: { id: { set: false, infinite: false, number: 0 } },
        },
        submit_time: { set: true, infinite: false, number: 1_788_509_904 },
        nodes: 'anode01',
      }],
    })
    expect(value).toMatchObject({
      jobId: '53697', state: 'COMPLETED', cpus: 1, gpus: 2, exitCode: '0:0', nodes: ['anode01'], submitTime: '2026-09-04T08:18:24.000Z',
    })
  })

  it('distinguishes malformed JSON, top-level Slurm errors, and missing ownership', () => {
    expect(() => parseSlurmJson('{', 'sinfo')).toThrowError(expect.objectContaining({ code: 'SLURM_INVALID_RESPONSE' }))
    expect(() => parseSlurmJson(JSON.stringify({ errors: [{ description: 'denied' }] }), 'sinfo')).toThrowError(expect.objectContaining({ code: 'SLURM_REJECTED' }))
    expect(() => normalizeJobs({ jobs: [{ job_id: 1, user_name: 'alice' }] })).toThrowError(expect.objectContaining({ code: 'SLURM_INVALID_RESPONSE' }))
  })
})

describe('Slurm runtime', () => {
  it('fails activation when one required command is unavailable', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.missing = 'sacctmgr'
    await expect(resolveSlurmCommands(ctx)).rejects.toMatchObject({ code: 'SLURM_COMMAND_UNAVAILABLE' })
  })

  it('discovers resources through fixed argv and awaits every child tree', async () => {
    const { subprocess, runtime } = await setup()
    subprocess.handler = resourceHandler
    const value = await runtime.resources()
    expect(value.combinations[0]?.limits.memoryMb).toBe(16_384)
    expect(subprocess.spawns).toHaveLength(3)
    expect(subprocess.spawns.every(spec => spec.stdio.stdin === 'ignore')).toBe(true)
    expect(subprocess.handles.every(handle => handle.waitCount === 1)).toBe(true)
  })

  it('rejects an over-limit request before sbatch', async () => {
    const { subprocess, runtime } = await setup()
    subprocess.handler = resourceHandler
    await expect(runtime.submit({ type: 'command', name: 'too-big', command: 'true', cpus: 5 }))
      .rejects.toMatchObject({ code: 'SLURM_RESOURCE_LIMIT' })
    expect(subprocess.spawns.some(spec => commandName(spec) === 'sbatch')).toBe(false)
  })

  it('writes a private command script and passes resource values only as sbatch argv', async () => {
    const { root, subprocess, runtime } = await setup()
    subprocess.handler = spec => commandName(spec) === 'sbatch' ? { stdout: '789;training\n' } : resourceHandler(spec)
    const result = await runtime.submit({
      type: 'command', name: 'argv-test', command: 'printf "hello"', workdir: join(root, 'project'),
      cpus: 2, memoryMb: 1024, timeMinutes: 10,
    })
    expect(result).toMatchObject({ jobId: '789', cluster: 'training', resources: { cpus: 2, memoryMb: 1024, timeMinutes: 10 } })
    const sbatch = subprocess.spawns.find(spec => commandName(spec) === 'sbatch')
    expect(sbatch?.argv).toEqual(expect.arrayContaining(['--cpus-per-task', '2', '--mem', '1024M', '--time', '10']))
    expect(sbatch?.argv).toEqual(expect.arrayContaining(['--account', 'competition']))
    expect(sbatch?.argv.join(' ')).not.toContain('printf "hello"')
    expect(result.scriptPath).toContain(`${join(root, 'project', '.dsh-slurm')}`)
  })

  it('rejects a symbolic-link generated-script directory', async () => {
    const { root, subprocess, runtime } = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-dongfeng-private-root-'))
    try {
      await symlink(outside, join(root, 'project', '.dsh-slurm'), 'dir')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    subprocess.handler = resourceHandler
    await expect(runtime.submit({ type: 'command', name: 'escape', command: 'true', workdir: join(root, 'project') }))
      .rejects.toMatchObject({ code: 'SLURM_FORBIDDEN_PATH' })
    expect(subprocess.spawns.some(spec => commandName(spec) === 'sbatch')).toBe(false)
  })

  it('submits an existing script without resource overrides', async () => {
    const { root, subprocess, runtime } = await setup()
    const script = join(root, 'project', 'existing.sbatch')
    await writeFile(script, '#!/bin/bash\ntrue\n')
    subprocess.handler = () => ({ stdout: '12\n' })
    const result = await runtime.submit({ type: 'script', scriptPath: script, workdir: join(root, 'project') })
    expect(result.resources).toBeUndefined()
    expect(subprocess.spawns[0]?.argv).toEqual(['/usr/bin/sbatch', '--parsable', '--chdir', join(root, 'project'), script])
  })

  it('rejects traversal and final-component symlink escapes', async () => {
    const { root, runtime } = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-dongfeng-outside-'))
    const outsideScript = join(outside, 'job.sbatch')
    await writeFile(outsideScript, 'true\n')
    await expect(runtime.submit({ type: 'script', scriptPath: outsideScript })).rejects.toMatchObject({ code: 'SLURM_FORBIDDEN_PATH' })
    const link = join(root, 'project', 'link.sbatch')
    try {
      await symlink(outsideScript, link, 'file')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    await expect(runtime.submit({ type: 'script', scriptPath: link })).rejects.toMatchObject({ code: 'SLURM_FORBIDDEN_PATH' })
  })

  it('rejects nonzero exits and lossy JSON output with stable codes', async () => {
    const { subprocess, runtime } = await setup()
    subprocess.handler = () => ({ stderr: 'Access denied', exitCode: 1 })
    await expect(runtime.resources()).rejects.toMatchObject({ code: 'SLURM_REJECTED' })
    subprocess.handler = () => ({ stdout: '{}', stdoutLossy: true })
    await expect(runtime.resources()).rejects.toMatchObject({ code: 'SLURM_INVALID_RESPONSE' })
  })

  it('waits for every aborted child tree before rejecting', async () => {
    const { subprocess, runtime } = await setup()
    const allWaiting = deferred<void>()
    const releaseExit = deferred<void>()
    let waiting = 0
    subprocess.handler = (spec) => {
      const done = new Promise<SubprocessOutcome>((_resolve, reject) => {
        const abort = (): void => reject(spec.signal?.reason ?? new Error('aborted'))
        if (spec.signal?.aborted) abort()
        else spec.signal?.addEventListener('abort', abort, { once: true })
      })
      return {
        done,
        async waitForExit() {
          waiting += 1
          if (waiting === 2) allWaiting.resolve()
          await releaseExit.promise
          return true
        },
      }
    }
    const controller = new AbortController()
    let settled = false
    const result = runtime.resources(controller.signal).finally(() => { settled = true })
    controller.abort(new Error('caller cancelled'))
    await allWaiting.promise
    expect(settled).toBe(false)
    releaseExit.resolve()
    await expect(result).rejects.toMatchObject({ code: 'SLURM_REJECTED' })
    expect(subprocess.handles.every(handle => handle.waitCount === 1)).toBe(true)
  })

  it('uses accounting history filters and enforces the configured list limit', async () => {
    const { root, subprocess, runtime } = await setup()
    const historical = JSON.stringify({
      jobs: [
        JSON.parse(job(root, { job_id: 123, job_state: 'RUNNING' })).jobs[0],
        JSON.parse(job(root, { job_id: 124, job_state: 'COMPLETED' })).jobs[0],
      ],
      warnings: [],
      errors: [],
    })
    subprocess.handler = () => ({ stdout: historical })
    const value = await runtime.listJobs({ since: '2026-09-01T00:00:00+08:00', states: ['COMPLETED'], limit: 1 })
    expect(value.map(item => item.jobId)).toEqual(['124'])
    expect(subprocess.spawns[0]?.argv).toEqual([
      '/usr/bin/sacct', '--json', '--user', 'alice', '--starttime', '2026-08-31T16:00:00.000Z', '--state', 'COMPLETED',
    ])
    await expect(runtime.listJobs({ limit: 101 })).rejects.toMatchObject({ code: 'SLURM_RESOURCE_LIMIT' })
    await expect(runtime.listJobs({ since: 'not-a-date' })).rejects.toMatchObject({ code: 'SLURM_INVALID_RESPONSE' })
  })

  it('checks uid and username independently for details and cancellation', async () => {
    const { root, subprocess, runtime } = await setup()
    subprocess.handler = () => ({ stdout: job(root, { user_id: 1001 }) })
    await expect(runtime.getJob(slurmJobId('123'))).rejects.toMatchObject({ code: 'SLURM_JOB_NOT_OWNED' })
    await expect(runtime.cancel(slurmJobId('123'))).rejects.toMatchObject({ code: 'SLURM_JOB_NOT_OWNED' })
    expect(subprocess.spawns.some(spec => commandName(spec) === 'scancel')).toBe(false)
  })

  it('reads bounded log tails and rejects logs outside the configured root', async () => {
    const { root, subprocess, runtime } = await setup()
    const stdoutPath = join(root, 'stdout.log')
    await writeFile(stdoutPath, '0123456789')
    subprocess.handler = spec => commandName(spec) === 'tail'
      ? { stdout: '6789' }
      : { stdout: job(root) }
    const value = await runtime.readLogs(slurmJobId('123'), 'stdout', 4)
    expect(value.stdout).toMatchObject({ text: '6789', exists: true, truncated: true })
    const outside = await mkdtemp(join(tmpdir(), 'dsh-dongfeng-log-'))
    const outsideLog = join(outside, 'stdout.log')
    await writeFile(outsideLog, 'secret')
    subprocess.handler = () => ({ stdout: job(root, { standard_output: outsideLog }) })
    await expect(runtime.readLogs(slurmJobId('123'), 'stdout', 4)).rejects.toMatchObject({ code: 'SLURM_FORBIDDEN_PATH' })
  })

  it('reports terminal-state cancellation races without invoking scancel', async () => {
    const { root, subprocess, runtime } = await setup()
    subprocess.handler = () => ({ stdout: job(root, { job_state: 'COMPLETED' }) })
    await expect(runtime.cancel(slurmJobId('123'))).resolves.toEqual({ jobId: '123', outcome: 'already-finished', state: 'COMPLETED' })
    expect(subprocess.spawns.some(spec => commandName(spec) === 'scancel')).toBe(false)
  })

  it('reports a terminal completion that races with a rejected scancel', async () => {
    const { root, subprocess, runtime } = await setup()
    let controllerReads = 0
    subprocess.handler = (spec) => {
      if (commandName(spec) === 'scancel') return { stderr: 'Invalid job id specified', exitCode: 1 }
      controllerReads += 1
      return { stdout: job(root, { job_state: controllerReads === 1 ? 'RUNNING' : 'COMPLETED' }) }
    }
    await expect(runtime.cancel(slurmJobId('123'))).resolves.toEqual({ jobId: '123', outcome: 'already-finished', state: 'COMPLETED' })
    expect(subprocess.spawns.map(commandName)).toEqual(['scontrol', 'scancel', 'scontrol'])
  })
})
