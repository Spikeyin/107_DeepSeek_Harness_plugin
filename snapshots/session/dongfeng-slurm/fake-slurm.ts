/** Deterministic Slurm subprocess provider for the recorded-session fixture. */

import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

process.env.USER = 'snapshot-user'
process.env.LOGNAME = 'snapshot-user'
process.env.UID = '1000'
Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true })

const ASSOCIATIONS = JSON.stringify({
  associations: [{ cluster: 'training', account: 'competition', user: 'snapshot-user', partition: '', qos: ['qos_stu_default'] }],
  warnings: [], errors: [],
})
const QOS = JSON.stringify({
  qos: [{
    name: 'qos_stu_default',
    limits: {
      max: {
        tres: { per: { job: [], user: [{ type: 'cpu', name: '', count: 4 }, { type: 'mem', name: '', count: 16_384 }, { type: 'gres', name: 'gpu', count: 1 }] } },
        wall_clock: { per: { job: { set: true, infinite: false, number: 240 } } },
      },
    },
  }],
  warnings: [], errors: [],
})
const PARTITIONS = JSON.stringify({
  sinfo: [{ partition: { name: 'Students', accounts: { allowed: 'competition', deny: '' }, qos: { allowed: 'qos_stu_default', deny: '' } } }],
  warnings: [], errors: [],
})

class Reader implements SubprocessOutputReader {
  constructor(private readonly text: string) {}
  readFrom(_offset: number): SubprocessOutputRead {
    return { text: this.text, nextOffset: Buffer.byteLength(this.text), lossy: false }
  }
}

class Handle implements SubprocessHandle {
  readonly pid = 107
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected
  readonly done = Promise.resolve({ exitCode: 0, signal: null })

  constructor(stdout: string) {
    this.collected = { stdout: new Reader(stdout), stderr: new Reader('') }
  }

  terminate(): void {}
  waitForExit(): Promise<boolean> { return Promise.resolve(true) }
}

function jobJson(): string {
  return JSON.stringify({
    jobs: [{
      job_id: 321,
      user_id: 1000,
      user_name: 'snapshot-user',
      name: 'snapshot-job',
      job_state: ['COMPLETED'],
      partition: 'Students',
      qos: 'qos_stu_default',
      cpus: { set: true, infinite: false, number: 1 },
      exit_code: { return_code: { set: true, infinite: false, number: 0 }, signal: { id: { set: false, infinite: false, number: 0 } } },
      standard_output: `${process.cwd()}/stdout.log`,
      standard_error: `${process.cwd()}/stderr.log`,
    }],
    warnings: [], errors: [],
  })
}

/** Fake execution-world provider used only by this fixture process. */
export class FakeSlurmSubprocess extends SubprocessRuntime {
  constructor(ctx: Context) { super(ctx) }

  override resolveExecutable(command: string): Promise<string> { return Promise.resolve(`/snapshot/bin/${command}`) }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const command = spec.argv[0]?.split('/').at(-1)
    if (command === 'sacctmgr' && spec.argv.includes('association')) return new Handle(ASSOCIATIONS)
    if (command === 'sacctmgr') return new Handle(QOS)
    if (command === 'sinfo') return new Handle(PARTITIONS)
    if (command === 'sbatch') return new Handle('321;training\n')
    if (command === 'scontrol' || command === 'sacct' || command === 'squeue') return new Handle(jobJson())
    if (command === 'tail') return new Handle('dsh-slurm-smoke\n')
    return new Handle('')
  }

  override spawnTerminal(): Promise<never> { return Promise.reject(new Error('fixture does not allocate terminals')) }
}

export default FakeSlurmSubprocess
