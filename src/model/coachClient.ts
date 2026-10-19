export type CoachCandidate = {
  move: string
  evaluation: string
  continuation: string
}

export type CoachRequest = {
  fen: string
  beforeFen: string
  pgn: string
  playerMove: string
  engineMove: string
  candidates: CoachCandidate[]
}

export type CoachReading = {
  coach: string
  model: string
  provider: 'cail-gateway'
  cached: boolean
}

export type CoachState =
  | { status: 'idle'; message: string }
  | { status: 'loading'; message: string }
  | { status: 'ready'; message: string; model: string; cached: boolean }
  | { status: 'error'; message: string }

const endpoint = '/api/coach'
export const COACH_CONFIGURED = true

export const INITIAL_COACH_STATE: CoachState = {
  status: 'idle',
  message: 'Complete a move, and the coach will read Stockfish’s reply lines.',
}

export async function requestCoach(
  position: CoachRequest,
  signal?: AbortSignal,
): Promise<CoachReading> {

  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 40_000)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(position),
      signal: controller.signal,
    })

    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(
        typeof result?.error === 'string' && result.error.length <= 240
          ? result.error
          : 'Chess Coach could not read this position.',
      )
    }

    if (
      typeof result?.coach !== 'string' || result.coach.trim().length < 20 || result.coach.length > 1_000 ||
      typeof result?.model !== 'string' || !result.model.trim() || result.model.length > 100 ||
      result.provider !== 'cail-gateway'
    ) {
      throw new Error('Chess Coach returned an incomplete reply.')
    }

    return {
      coach: result.coach.trim(),
      model: result.model,
      provider: 'cail-gateway',
      cached: result.cached === true,
    }
  } catch (error) {
    if (timedOut) throw new Error('Chess Coach took too long to answer. You can keep playing and retry later.')
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}
