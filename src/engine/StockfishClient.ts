import { Chess } from 'chess.js'
import { parseInfoLine, type EngineLine } from './uci'

export type StockfishAnalysis = {
  bestMove: string
  ponder: string | null
  lines: EngineLine[]
}

type Timer = ReturnType<typeof setTimeout>
type EngineState = 'loading' | 'ready' | 'error' | 'terminated'

type PendingAnalysis = {
  lines: Map<number, EngineLine>
  resolve: (analysis: StockfishAnalysis) => void
  reject: (error: Error) => void
  timeout: Timer
}

type StopBarrier = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timeout: Timer
}

const STARTUP_TIMEOUT_MS = 15_000
const SEARCH_TIME_MS = 1_500
const SEARCH_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 2_000
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/

function cancelled(message: string) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export class StockfishClient {
  private worker: Worker | null = null
  private readyPromise!: Promise<void>
  private markReady!: () => void
  private markFailed!: (error: Error) => void
  private startupTimeout: Timer | null = null
  private pending: PendingAnalysis | null = null
  private stopBarrier: StopBarrier | null = null
  private state: EngineState = 'loading'
  private failure: Error | null = null
  private generation = 0
  private requestId = 0
  private removeListeners: (() => void) | null = null
  private readonly engineUrl: string

  constructor(baseUrl: string) {
    this.engineUrl = `${baseUrl}engine/stockfish-18-lite-single.js`
    this.startWorker()
  }

  ready(): Promise<void> {
    if (this.state === 'error' || this.state === 'terminated') {
      return Promise.reject(this.failure ?? new Error('Stockfish is unavailable.'))
    }
    return this.readyPromise
  }

  async analyze(fen: string, depth = 11): Promise<StockfishAnalysis> {
    const position = new Chess(fen).fen()
    if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
      throw new Error('Stockfish depth must be between 1 and 30.')
    }
    const requestId = ++this.requestId
    await this.ready()
    this.assertCurrent(requestId)

    this.stopSearch(cancelled('Engine search replaced by a newer position.'))
    if (this.stopBarrier) await this.stopBarrier.promise
    this.assertCurrent(requestId)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error('Stockfish took too long to answer. Reload the engine to continue.'))
      }, SEARCH_TIMEOUT_MS)

      this.pending = { lines: new Map(), resolve, reject, timeout }
      try {
        this.worker!.postMessage(`position fen ${position}`)
        // A wall-clock limit also bounds depth searches on slower phones.
        this.worker!.postMessage(`go depth ${depth} movetime ${SEARCH_TIME_MS}`)
      } catch {
        this.fail(new Error('Stockfish could not start its search. Reload the engine to continue.'))
      }
    })
  }

  cancel() {
    this.requestId += 1
    this.stopSearch(cancelled('Engine search cancelled.'))
  }

  restart(): Promise<void> {
    this.dispose(cancelled('Engine restarted.'), 'terminated')
    this.startWorker()
    return this.ready()
  }

  terminate() {
    this.dispose(cancelled('Engine stopped.'), 'terminated')
  }

  private assertCurrent(requestId: number) {
    if (requestId !== this.requestId) {
      throw cancelled('Engine search replaced by a newer position.')
    }
    if (this.state !== 'ready' || !this.worker) {
      throw this.failure ?? new Error('Stockfish is unavailable.')
    }
  }

  private startWorker() {
    this.state = 'loading'
    this.failure = null
    const generation = ++this.generation
    this.readyPromise = new Promise((resolve, reject) => {
      this.markReady = resolve
      this.markFailed = reject
    })
    // Cleanup may precede the first caller of ready(), including React StrictMode.
    void this.readyPromise.catch(() => {})
    this.startupTimeout = setTimeout(() => {
      this.fail(new Error('Stockfish could not finish loading. Reload the engine to try again.'))
    }, STARTUP_TIMEOUT_MS)

    try {
      const worker = new Worker(this.engineUrl)
      this.worker = worker
      let configured = false
      const onMessage = (event: MessageEvent) => {
        if (generation !== this.generation || typeof event.data !== 'string') return
        for (const text of event.data.split(/\r?\n/)) {
          const line = text.trim()
          if (line === 'uciok' && this.state === 'loading' && !configured) {
            configured = true
            worker.postMessage('setoption name Skill Level value 8')
            worker.postMessage('setoption name MultiPV value 3')
            worker.postMessage('setoption name Hash value 32')
            worker.postMessage('setoption name Ponder value false')
            worker.postMessage('isready')
          } else if (line === 'readyok' && this.state === 'loading' && configured) {
            if (this.startupTimeout !== null) clearTimeout(this.startupTimeout)
            this.startupTimeout = null
            this.state = 'ready'
            this.markReady()
          } else {
            this.handleSearchLine(line)
          }
        }
      }
      const onError = () => {
        if (generation === this.generation) {
          this.fail(new Error('Stockfish could not run in this browser. Reload the engine to try again.'))
        }
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', onError)
      this.removeListeners = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        worker.removeEventListener('messageerror', onError)
      }
      worker.postMessage('uci')
    } catch {
      this.fail(new Error('Stockfish could not load in this browser.'))
    }
  }

  private stopSearch(error: Error) {
    if (!this.pending || !this.worker) return
    const pending = this.pending
    this.pending = null
    clearTimeout(pending.timeout)
    pending.reject(error)

    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    void promise.catch(() => {})
    const timeout = setTimeout(() => {
      this.fail(new Error('Stockfish could not stop its previous search. Reload the engine to continue.'))
    }, STOP_TIMEOUT_MS)
    this.stopBarrier = { promise, resolve, reject, timeout }
    try {
      this.worker.postMessage('stop')
    } catch {
      this.fail(new Error('Stockfish could not stop its search. Reload the engine to continue.'))
    }
  }

  private handleSearchLine(line: string) {
    // UCI has no request IDs. The stopped search owns all output through bestmove.
    if (this.stopBarrier) {
      if (line.startsWith('bestmove ')) {
        const barrier = this.stopBarrier
        this.stopBarrier = null
        clearTimeout(barrier.timeout)
        barrier.resolve()
      }
      return
    }
    if (!this.pending) return

    const parsed = parseInfoLine(line)
    if (parsed) {
      const previous = this.pending.lines.get(parsed.multipv)
      if (!previous || parsed.depth >= previous.depth) {
        this.pending.lines.set(parsed.multipv, parsed)
      }
      return
    }

    if (line.startsWith('bestmove ')) {
      const [, bestMove, ponderLabel, ponderMove] = line.split(/\s+/)
      if (!UCI_MOVE.test(bestMove ?? '')) {
        this.fail(new Error('Stockfish did not return a playable move.'))
        return
      }
      const pending = this.pending
      this.pending = null
      clearTimeout(pending.timeout)
      pending.resolve({
        bestMove,
        ponder: ponderLabel === 'ponder' && UCI_MOVE.test(ponderMove ?? '') ? ponderMove : null,
        lines: [...pending.lines.values()].sort((a, b) => a.multipv - b.multipv),
      })
    }
  }

  private fail(error: Error) {
    this.dispose(error, 'error')
  }

  private dispose(error: Error, state: EngineState) {
    this.requestId += 1
    this.generation += 1
    if (this.state === 'loading') this.markFailed(error)
    this.state = state
    this.failure = error
    if (this.startupTimeout !== null) clearTimeout(this.startupTimeout)
    this.startupTimeout = null
    if (this.pending) {
      clearTimeout(this.pending.timeout)
      this.pending.reject(error)
      this.pending = null
    }
    if (this.stopBarrier) {
      clearTimeout(this.stopBarrier.timeout)
      this.stopBarrier.reject(error)
      this.stopBarrier = null
    }
    this.removeListeners?.()
    this.removeListeners = null
    this.worker?.terminate()
    this.worker = null
  }
}
