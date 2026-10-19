import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoachRequest } from './coachClient'

const position: CoachRequest = {
  fen: 'after', beforeFen: 'before', pgn: '1. e4 c5', playerMove: 'e4', engineMove: 'c5',
  candidates: [{ move: 'c5', evaluation: '+0.18', continuation: 'c5 Nf3' }],
}
const reply = {
  coach: 'You claimed the center with e4. Develop a knight to support it.',
  model: '@cf/google/gemma-4-26b-a4b-it', provider: 'cail-gateway', cached: false,
}
async function client() {
  vi.resetModules()
  return import('./coachClient')
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('coach client', () => {
  it('preserves the checked position contract and reads a valid reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(reply))
    vi.stubGlobal('fetch', fetchMock)
    const { requestCoach } = await client()
    await expect(requestCoach(position)).resolves.toEqual(reply)
    expect(fetchMock).toHaveBeenCalledWith('/api/coach', expect.objectContaining({ method: 'POST', body: JSON.stringify(position) }))
  })

  it('rejects incomplete model replies and null response bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...reply, coach: '' }))
      .mockResolvedValueOnce(Response.json(null))
    vi.stubGlobal('fetch', fetchMock)
    const { requestCoach } = await client()
    await expect(requestCoach(position)).rejects.toThrow('incomplete reply')
    await expect(requestCoach(position)).rejects.toThrow('incomplete reply')
  })

  it('propagates cancellation so a stale position cannot keep an inference running', async () => {
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      requestSignal = options.signal
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))
      })
    }))
    const { requestCoach } = await client()
    const controller = new AbortController()
    const pending = requestCoach(position, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
    expect(requestSignal?.aborted).toBe(true)
  })

  it('bounds the browser wait if the server stops responding', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))
    })))
    const { requestCoach } = await client()
    const pending = requestCoach(position)
    const assertion = expect(pending).rejects.toThrow('too long to answer')
    await vi.advanceTimersByTimeAsync(40_000)
    await assertion
  })
})
