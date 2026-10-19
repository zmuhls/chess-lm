import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StockfishClient } from './StockfishClient'

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

class FakeWorker {
  static instances: FakeWorker[] = []
  readonly messages: string[] = []
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  terminated = false
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeWorker.instances.push(this)
  }

  postMessage(message: string) {
    if (this.terminated) throw new Error('Worker terminated')
    this.messages.push(message)
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(name)?.delete(listener)
  }

  emit(data: string, type = 'message') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent)
    }
  }

  handshake() {
    this.emit('uciok')
    this.emit('readyok')
  }

  terminate() {
    this.terminated = true
  }
}

const clients: StockfishClient[] = []

function createClient() {
  const client = new StockfishClient('/chess-lm/')
  clients.push(client)
  return { client, worker: FakeWorker.instances.at(-1)! }
}

async function readyClient() {
  const result = createClient()
  result.worker.handshake()
  await result.client.ready()
  return result
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Stockfish worker lifecycle', () => {
  it('configures skill 8 and starts a time-bounded search after the handshake', async () => {
    const { client, worker } = createClient()
    const analysis = client.analyze(AFTER_E4)
    worker.emit('readyok')
    await flushPromises()
    expect(worker.messages).toEqual(['uci'])
    worker.handshake()
    await flushPromises()
    expect(worker.url).toBe('/chess-lm/engine/stockfish-18-lite-single.js')
    expect(worker.messages).toContain('setoption name Skill Level value 8')
    expect(worker.messages).toContain('setoption name MultiPV value 3')
    expect(worker.messages.at(-1)).toBe('go depth 11 movetime 1500')
    worker.emit('info depth 8 multipv 2 score cp 12 pv e7e5 g1f3\ninfo depth 9 multipv 1 score cp 22 pv c7c5 g1f3')
    worker.emit('bestmove c7c5 ponder g1f3')
    await expect(analysis).resolves.toMatchObject({
      bestMove: 'c7c5',
      ponder: 'g1f3',
      lines: [{ depth: 9, multipv: 1 }, { depth: 8, multipv: 2 }],
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains the old bestmove before starting a replacement position', async () => {
    const { client, worker } = await readyClient()
    const oldAnalysis = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    await flushPromises()
    const replacement = client.analyze(AFTER_E4)
    await flushPromises()
    expect(await oldAnalysis).toMatchObject({ name: 'AbortError' })
    expect(worker.messages.at(-1)).toBe('stop')
    expect(worker.messages.filter((message) => message.startsWith('position'))).toHaveLength(1)

    worker.emit('info depth 11 multipv 1 score cp 99 pv e2e4 e7e5')
    worker.emit('bestmove e2e4')
    await flushPromises()
    expect(worker.messages.filter((message) => message.startsWith('position'))).toHaveLength(2)
    worker.emit('info depth 8 multipv 1 score cp 10 pv c7c5 g1f3')
    worker.emit('bestmove c7c5')
    await expect(replacement).resolves.toMatchObject({
      bestMove: 'c7c5', lines: [{ pv: ['c7c5', 'g1f3'] }],
    })
  })

  it('starts only the newest request queued during startup', async () => {
    const { client, worker } = createClient()
    const oldAnalysis = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    const newest = client.analyze(AFTER_E4)
    worker.handshake()
    await flushPromises()
    expect(await oldAnalysis).toMatchObject({ name: 'AbortError' })
    expect(worker.messages.filter((message) => message.startsWith('position')))
      .toEqual([`position fen ${AFTER_E4}`])
    worker.emit('bestmove c7c5')
    await expect(newest).resolves.toMatchObject({ bestMove: 'c7c5' })
  })

  it('starts only the newest request queued while stopping', async () => {
    const { client, worker } = await readyClient()
    const first = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    await flushPromises()
    const second = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    await flushPromises()
    const third = client.analyze(AFTER_E4)
    await flushPromises()
    worker.emit('bestmove e2e4')
    await flushPromises()
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(await second).toMatchObject({ name: 'AbortError' })
    expect(worker.messages.filter((message) => message.startsWith('go'))).toHaveLength(2)
    worker.emit('bestmove c7c5')
    await expect(third).resolves.toMatchObject({ bestMove: 'c7c5' })
  })

  it('cancels queued work before startup without sending a search', async () => {
    const { client, worker } = createClient()
    const analysis = client.analyze(AFTER_E4).catch((error: Error) => error)
    client.cancel()
    worker.handshake()
    await flushPromises()
    expect(await analysis).toMatchObject({ name: 'AbortError' })
    expect(worker.messages.some((message) => message.startsWith('go'))).toBe(false)
  })

  it('cancels an active search and safely allows a later turn', async () => {
    const { client, worker } = await readyClient()
    const analysis = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    await flushPromises()
    client.cancel()
    expect(await analysis).toMatchObject({ name: 'AbortError' })
    worker.emit('bestmove e2e4')
    const next = client.analyze(AFTER_E4)
    await flushPromises()
    worker.emit('bestmove c7c5')
    await expect(next).resolves.toMatchObject({ bestMove: 'c7c5' })
  })

  it('terminates a worker that never acknowledges a stopped search', async () => {
    const { client, worker } = await readyClient()
    const first = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    await flushPromises()
    const next = client.analyze(AFTER_E4).catch((error: Error) => error)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(await next).toMatchObject({ message: expect.stringContaining('previous search') })
    expect(worker.terminated).toBe(true)
    expect(worker.messages.filter((message) => message.startsWith('position'))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds startup and can recover with a fresh worker', async () => {
    const { client, worker } = createClient()
    const readiness = client.ready().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await readiness).toMatchObject({ message: expect.stringContaining('finish loading') })
    expect(worker.terminated).toBe(true)
    const restart = client.restart()
    const replacement = FakeWorker.instances.at(-1)!
    expect(replacement).not.toBe(worker)
    worker.handshake()
    expect(replacement.messages).toEqual(['uci'])
    replacement.handshake()
    await expect(restart).resolves.toBeUndefined()
    const analysis = client.analyze(AFTER_E4)
    await flushPromises()
    replacement.emit('bestmove c7c5')
    await expect(analysis).resolves.toMatchObject({ bestMove: 'c7c5' })
  })

  it('rejects readiness on termination and cannot silently resume', async () => {
    const { client, worker } = createClient()
    const readiness = client.ready().catch((error: Error) => error)
    client.terminate()
    client.terminate()
    expect(await readiness).toMatchObject({ name: 'AbortError' })
    await expect(client.analyze(AFTER_E4)).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores delayed messages from a worker replaced during an active search', async () => {
    const { client, worker } = await readyClient()
    const oldListener = [...worker.listeners.get('message')!][0]
    const oldAnalysis = client.analyze(INITIAL_FEN).catch((error: Error) => error)
    await flushPromises()
    const restarted = client.restart()
    expect(await oldAnalysis).toMatchObject({ name: 'AbortError' })
    const replacement = FakeWorker.instances.at(-1)!
    replacement.handshake()
    await restarted
    const analysis = client.analyze(AFTER_E4)
    await flushPromises()
    oldListener({ data: 'bestmove e2e4' } as MessageEvent)
    replacement.emit('bestmove c7c5')
    await expect(analysis).resolves.toMatchObject({ bestMove: 'c7c5' })
    expect(worker.terminated).toBe(true)
  })

  it('terminates an unresponsive search instead of reusing its stale output', async () => {
    const { client, worker } = await readyClient()
    const analysis = client.analyze(AFTER_E4).catch((error: Error) => error)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await analysis).toMatchObject({ message: expect.stringContaining('too long') })
    expect(worker.terminated).toBe(true)
    await expect(client.ready()).rejects.toThrow('too long')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects startup if Worker construction fails', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked') } })
    const client = new StockfishClient('/chess-lm/')
    clients.push(client)
    await expect(client.ready()).rejects.toThrow('could not load')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects active work on a worker error and releases every timer', async () => {
    const { client, worker } = await readyClient()
    const analysis = client.analyze(AFTER_E4).catch((error: Error) => error)
    await flushPromises()
    worker.emit('', 'error')
    expect(await analysis).toMatchObject({ message: expect.stringContaining('could not run') })
    expect(worker.terminated).toBe(true)
    await expect(client.ready()).rejects.toThrow('could not run')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a missing bestmove instead of applying a malformed move', async () => {
    const { client, worker } = await readyClient()
    const analysis = client.analyze(AFTER_E4).catch((error: Error) => error)
    await flushPromises()
    worker.emit('bestmove (none)')
    expect(await analysis).toMatchObject({ message: expect.stringContaining('playable move') })
    expect(worker.terminated).toBe(true)
  })
})
