/** Tool registration, concurrency metadata, approval routing, and HMR disposal tests. */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { slurmJobId } from '../src/index.ts'
import type { Config, SlurmOperations } from '../src/index.ts'

const signal = new AbortController().signal

const config: Config = {
  workRoot: '/work',
  defaultPartition: 'Students',
  defaultQos: 'qos_stu_default',
  commandTimeoutMs: 15_000,
  logMaxBytes: 65_536,
  listMaxItems: 100,
  cancelRequiresApproval: true,
  rawOutputMaxBytes: 1_048_576,
  graceMs: 3000,
}

function operations() {
  const calls: string[] = []
  const job = {
    jobId: slurmJobId('1'),
    name: 'test',
    state: 'RUNNING',
    nodes: [],
    user: 'alice',
    uid: 1000,
  }
  const runtime: SlurmOperations = {
    resources: async () => {
      calls.push('resources')
      return { user: 'alice', defaultPartition: 'Students', defaultQos: 'qos_stu_default', combinations: [], warnings: [] }
    },
    submit: async () => { calls.push('submit'); return { jobId: slurmJobId('1'), scriptPath: '/work/job.sbatch', workdir: '/work' } },
    listJobs: async () => { calls.push('list'); return [] },
    getJob: async jobId => { calls.push('get'); return { ...job, jobId } },
    readLogs: async () => { calls.push('logs'); return {} },
    cancel: async jobId => { calls.push('cancel'); return { jobId, outcome: 'cancelled' } },
  }
  return { runtime, calls }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fake = operations()
  const fiber = await ctx.plugin({
    name: 'dongfeng-slurm-registration-test',
    inject: ['tools'],
    apply(child: Context) { plugin.registerSlurmTools(child, config, fake.runtime) },
  })
  return { ctx, fiber, ...fake }
}

function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ callId: ToolCallId(`test-${name}`), name, arguments: args, signal })
}

describe('dongfeng-slurm registration', () => {
  it('keeps the namespace export intact for the real Loader unwrap path', async () => {
    const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
    expect('default' in plugin).toBe(false)
    const loader = Object.create(Loader.prototype) as InstanceType<typeof Loader>
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.inject).toEqual(['tools', 'subprocess', 'fs'])
    expect(typeof unwrapped.Config).toBe('function')
  })

  it('registers six tools and removes them on fiber disposal', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'slurm_cancel', 'slurm_get_job', 'slurm_list_jobs', 'slurm_read_logs', 'slurm_resources', 'slurm_submit',
    ])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('marks query tools parallel and submit/cancel exclusive', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('slurm_resources')?.isConcurrencySafe?.({})).toBe(true)
    expect(ctx.tools.get('slurm_list_jobs')?.isConcurrencySafe?.({})).toBe(true)
    expect(ctx.tools.get('slurm_get_job')?.isConcurrencySafe?.({ jobId: '1' })).toBe(true)
    expect(ctx.tools.get('slurm_read_logs')?.isConcurrencySafe?.({ jobId: '1' })).toBe(true)
    expect(ctx.tools.get('slurm_submit')?.isConcurrencySafe).toBeUndefined()
    expect(ctx.tools.get('slurm_cancel')?.isConcurrencySafe).toBeUndefined()
  })

  it('requires approval only for cancellation and fails closed without a channel', async () => {
    const { ctx, calls } = await setup()
    await expect(execute(ctx, 'slurm_resources', {})).resolves.toMatchObject({ isError: false })
    const cancelled = await execute(ctx, 'slurm_cancel', { jobId: '123' })
    expect(cancelled).toMatchObject({ isError: true })
    expect(cancelled.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Cancel Slurm job 123?') })
    expect(calls).toEqual(['resources'])
  })

  it('uses a strict discriminated request schema', async () => {
    const { ctx } = await setup()
    const submit = ctx.tools.schemas().find(schema => schema.name === 'slurm_submit')
    const request = (submit?.parameters.properties as Record<string, unknown> | undefined)?.request
    expect(request).toMatchObject({ oneOf: [{ properties: { type: { const: 'command' } } }, { properties: { type: { const: 'script' } } }] })
    const invalid = await execute(ctx, 'slurm_submit', { request: { type: 'script', scriptPath: 'x.sbatch', cpus: 2 } })
    expect(invalid).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
  })

  it('publishes stable structured output schemas for every tool', async () => {
    const { ctx } = await setup()
    const schemas = new Map(ctx.tools.schemas().map(schema => [schema.name, ctx.tools.get(schema.name)?.output.schema]))
    expect(schemas.get('slurm_resources')).toMatchObject({ type: 'object', required: ['user', 'defaultPartition', 'defaultQos', 'combinations', 'warnings'] })
    expect(schemas.get('slurm_submit')).toMatchObject({ type: 'object', required: ['jobId', 'scriptPath', 'workdir'] })
    expect(schemas.get('slurm_list_jobs')).toMatchObject({ type: 'array', items: { type: 'object', required: expect.arrayContaining(['jobId', 'state', 'user', 'uid']) } })
    expect(schemas.get('slurm_get_job')).toMatchObject({ type: 'object', required: expect.arrayContaining(['jobId', 'state', 'user', 'uid']) })
    expect(schemas.get('slurm_read_logs')).toMatchObject({ type: 'object', properties: { stdout: { type: 'object' }, stderr: { type: 'object' } } })
    expect(schemas.get('slurm_cancel')).toMatchObject({ type: 'object', required: ['jobId', 'outcome'] })
    for (const schema of schemas.values()) expect(schema).not.toEqual({})
  })
})
