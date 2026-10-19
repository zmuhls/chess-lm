import { Chess } from 'chess.js'

export const DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it'

export class CoachInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CoachInputError'
  }
}

export class CoachServiceError extends Error {
  constructor(message, status = 502, upstreamStatus) {
    super(message)
    this.name = 'CoachServiceError'
    this.status = status
    this.upstreamStatus = upstreamStatus
  }
}

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoachInputError(`${label} is required.`)
  }

  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new CoachInputError(`${label} is too long.`)
  }
  return trimmed
}

export function validateCoachRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CoachInputError('A chess position is required.')
  }

  let fen
  try {
    fen = new Chess(requiredString(input.fen, 'FEN', 120)).fen()
  } catch {
    throw new CoachInputError('FEN must describe a legal chess position.')
  }

  const suppliedPgn = requiredString(input.pgn, 'Game history', 8_000)
  const playerMove = requiredString(input.playerMove, 'Player move', 24)
  const engineMove = requiredString(input.engineMove, 'Stockfish reply', 24)
  const history = new Chess()
  try {
    history.loadPgn(suppliedPgn, { strict: true })
  } catch {
    throw new CoachInputError('Game history must contain legal chess moves.')
  }
  if (history.fen() !== fen) {
    throw new CoachInputError('Game history does not match the current position.')
  }
  // Canonical SAN contains chess data only; PGN headers and comments never enter the prompt.
  const pgn = history.history().slice(-16).join(' ')
  if (history.undo()?.san !== engineMove) {
    throw new CoachInputError('Stockfish reply does not match game history.')
  }
  const beforeFen = history.fen()
  if (input.beforeFen !== undefined && input.beforeFen !== beforeFen) {
    throw new CoachInputError('The position before Stockfish replied does not match game history.')
  }
  if (history.undo()?.san !== playerMove) {
    throw new CoachInputError('Player move does not match game history.')
  }

  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 3) {
    throw new CoachInputError('One to three Stockfish candidates are required.')
  }

  const candidates = input.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new CoachInputError(`Candidate ${index + 1} is invalid.`)
    }

    const move = requiredString(candidate.move, `Candidate ${index + 1} move`, 24)
    const evaluation = requiredString(candidate.evaluation, `Candidate ${index + 1} evaluation`, 16)
    if (!/^(?:[+−-]?\d{1,4}\.\d{1,2}|[−-]?M\d{1,3})$/.test(evaluation)) {
      throw new CoachInputError(`Candidate ${index + 1} evaluation is invalid.`)
    }
    const continuation = requiredString(candidate.continuation, `Candidate ${index + 1} continuation`, 160)
    const moves = continuation.split(/\s+/)
    if (moves.length > 12 || moves[0] !== move) {
      throw new CoachInputError(`Candidate ${index + 1} must start with its supplied move.`)
    }
    const line = new Chess(beforeFen)
    try {
      for (const san of moves) {
        if (line.move(san, { strict: true }).san !== san) throw new Error('Noncanonical SAN')
      }
    } catch {
      throw new CoachInputError(`Candidate ${index + 1} contains an illegal continuation.`)
    }
    return { move, evaluation, continuation: moves.join(' ') }
  })

  if (new Set(candidates.map((candidate) => candidate.move)).size !== candidates.length) {
    throw new CoachInputError('Stockfish candidate moves must be unique.')
  }

  return { fen, beforeFen, pgn, playerMove, engineMove, candidates }
}

export function buildCoachMessages(position) {
  const candidateText = position.candidates
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.move} | ${candidate.evaluation} | ${candidate.continuation}`,
    )
    .join('\n')

  return [
    {
      role: 'system',
      content:
        "You are Chess Coach for a player facing Stockfish 18 at UCI Skill Level 8. Stockfish owns move selection. The FEN is the current position after Stockfish's reply. In sentence one, explain what the player's move changed and how Stockfish's played reply answers it. In sentence two, give one practical plan. Use candidate lines only when the played reply matches one of them, and omit them otherwise. Mention the played reply exactly as written. Write exactly two connected sentences, 35 to 70 words, in plain text and address the player as 'you'.",
    },
    {
      role: 'user',
      content: [
        `Current FEN after Stockfish's reply: ${position.fen}`,
        `Recent played moves in SAN: ${position.pgn}`,
        `Player move: ${position.playerMove}`,
        `Stockfish played reply: ${position.engineMove}`,
        `FEN before Stockfish's reply: ${position.beforeFen}`,
        'Supplied Stockfish candidate lines, checked for legal moves (move | evaluation for White | continuation):',
        candidateText,
      ].join('\n'),
    },
  ]
}

export function cleanCoachReply(value) {
  if (typeof value !== 'string') throw new CoachServiceError('The coach returned an empty reply.')
  const cleaned = value
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"]|['"]$/g, '')

  if (cleaned.length < 20) throw new CoachServiceError('The coach returned an incomplete reply.')
  const bounded = cleaned.slice(0, 1_000)
  const lastPunctuation = Math.max(
    bounded.lastIndexOf('.'),
    bounded.lastIndexOf('!'),
    bounded.lastIndexOf('?'),
  )
  return lastPunctuation >= 20 ? bounded.slice(0, lastPunctuation + 1) : bounded
}

export function gatewayModel(model) {
  return model.startsWith('@cf/') ? model.split('/').at(-1) : model
}

export async function readBoundedJson(source, maxBytes, signal, input = false) {
  const fail = (message) => input ? new CoachInputError(message) : new CoachServiceError(message)
  if (Number(source.headers.get('content-length')) > maxBytes) throw fail('The request or response is too large.')
  if (!source.body) throw fail('A JSON body is required.')
  const reader = source.body.getReader()
  const chunks = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) throw signal.reason
    while (true) {
      const { value, done } = await reader.read()
      if (signal?.aborted) throw signal.reason
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw fail('The request or response is too large.')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder().decode(bytes)) }
    catch { throw fail('The request or response must use JSON.') }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export async function requestGatewayCoach(position, { gateway, apiKey, model = DEFAULT_MODEL, signal } = {}) {
  if (!apiKey || !gateway) throw new CoachServiceError('The coach is unavailable while its connection is configured.', 503)
  if (signal?.aborted) throw signal.reason
  const response = await gateway.fetch(new Request('https://tools.ailab.gc.cuny.edu/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: gatewayModel(model), messages: buildCoachMessages(position), stream: false,
      max_tokens: 180, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
    }),
    signal,
  }))
  if (!response.ok) {
    await response.body?.cancel()
    const unavailable = [401, 402, 403, 404, 410].includes(response.status)
    const message = unavailable
      ? 'The coach connection needs an update. You can keep playing while it is repaired.'
      : response.status === 429
        ? 'The coach has reached its current allowance. Please try again later.'
        : 'The coach could not finish this reading. Please try again.'
    throw new CoachServiceError(message, unavailable ? 503 : response.status === 429 ? 429 : 502, response.status)
  }
  const result = await readBoundedJson(response, 32_768, signal)
  if (typeof result?.model !== 'string' || !result.model || result.model.length > 160) {
    throw new CoachServiceError('The coach returned an incomplete reply.')
  }
  return {
    coach: cleanCoachReply(result?.choices?.[0]?.message?.content),
    model: result.model,
    provider: 'cail-gateway',
  }
}
