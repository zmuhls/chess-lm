import {
  CoachInputError,
  CoachServiceError,
  DEFAULT_MODEL,
  gatewayModel,
  readBoundedJson,
  requestGatewayCoach,
  validateCoachRequest,
} from './coach.js'

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://gvgai.inference-arcade.com",
}
const json = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...headers },
})

function configured(env) {
  return Boolean(env.CAIL_GATEWAY_KEY && env.GATEWAY && env.REQUEST_LIMIT && env.GLOBAL_LIMIT)
}

function sameSiteRequest(request, env) {
  const origin = request.headers.get('origin')
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false
  const requestUrl = new URL(request.url)
  if (origin && ['localhost', '127.0.0.1'].includes(requestUrl.hostname)) {
    try {
      if (['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) return true
    } catch { return false }
  }
  // This is browser request hygiene, not authentication; the app credential stays in the Worker.
  return !origin || origin === requestUrl.origin || origin === env.PUBLIC_ORIGIN
}

async function withDeadline(signal, ms, run) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason || new CoachServiceError('The coaching request was cancelled.', 499))
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => controller.abort(new CoachServiceError('The coach took too long to answer. Please try again.', 504)), ms)
  let stopListening
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(controller.signal.reason)
    stopListening = () => controller.signal.removeEventListener('abort', onAbort)
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    if (controller.signal.aborted) throw controller.signal.reason
    return await Promise.race([run(controller.signal), aborted])
  }
  finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    stopListening()
  }
}

function cachePut(cache, key, value, ttl, ctx, logger) {
  if (!cache) return
  const response = Response.json(value, { headers: { 'cache-control': `public, max-age=${ttl}` } })
  ctx.waitUntil(cache.put(key, response).catch(() => logger.warn?.('chess_cache_write_failed')))
}

async function featuredModel(model, env, cache, baseUrl, ctx, signal, logger) {
  const key = new Request(`${baseUrl}/__coach_cache/featured-v1`)
  const cached = await cache?.match(key)
  let models
  if (cached) {
    try { models = await readBoundedJson(cached, 32_768, signal) } catch { models = null }
  }
  if (!Array.isArray(models)) {
    const response = await env.GATEWAY.fetch(new Request('https://tools.ailab.gc.cuny.edu/v1/catalog', { signal }))
    if (!response.ok) {
      await response.body?.cancel()
      throw new CoachServiceError('The coach model list is temporarily unavailable.', 503)
    }
    const catalog = await readBoundedJson(response, 1_048_576, signal)
    const data = catalog?.data ?? catalog?.models
    if (!Array.isArray(data)) throw new CoachServiceError('The coach model list is temporarily unavailable.', 503)
    models = data.filter((entry) => entry?.status === 'active' && entry.recommended === true && entry.tier === 'recommended' && entry.order !== undefined && entry.provider === 'workers-ai').map((entry) => entry.id).filter((id) => typeof id === 'string')
    if (models.length) cachePut(cache, key, models, 300, ctx, logger)
  }
  if (!models.includes(gatewayModel(model))) throw new CoachServiceError('The selected coach model is no longer available. You can keep playing while it is updated.', 503)
}

export function createWorker({ timeoutMs = 35_000, bodyTimeoutMs = 10_000, cache: testCache, logger = console } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const model = env.COACH_MODEL || DEFAULT_MODEL
      if (url.pathname === '/health' && request.method === 'GET') {
        const ready = configured(env)
        return json({ ok: ready, status: ready ? 'ok' : 'unavailable', configured: ready, provider: 'cail-gateway', model, runtime: 'cloudflare-workers', release: env.RELEASE || 'dev' }, ready ? 200 : 503)
      }
      if (url.pathname !== '/api/coach') {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__coach_cache/')) return json({ error: 'Route not found.' }, 404)
        if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, HEAD' })
        const asset = await env.ASSETS.fetch(request)
        const headers = new Headers(asset.headers)
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
        return new Response(asset.body, { status: asset.status, headers })
      }
      if (request.method !== 'POST') return json({ error: 'Use POST for a coaching request.' }, 405, { allow: 'POST' })
      if (!sameSiteRequest(request, env)) return json({ error: 'Reload this page before requesting a reading.' }, 403)
      const startedAt = Date.now()
      try {
        if (!configured(env)) throw new CoachServiceError('The coach is unavailable while its connection is configured.', 503)
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ error: 'Send the coaching request as JSON.' }, 415)
        const client = request.headers.get('cf-connecting-ip') || 'local'
        if (!(await env.REQUEST_LIMIT.limit({ key: `chess-lm:client:${client}` })).success) return json({ error: 'Give the coach a moment before requesting another reading.' }, 429, { 'retry-after': '60' })
        const position = validateCoachRequest(await withDeadline(request.signal, bodyTimeoutMs, (signal) => readBoundedJson(request, 16_384, signal, true)))
        const cache = testCache ?? globalThis.caches?.default
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ prompt: 1, model, ...position })))
        const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        const key = new Request(`${url.origin}/__coach_cache/reading-v1/${digest}`)
        const cached = await cache?.match(key)
        if (cached) {
          const value = await readBoundedJson(cached, 4_096, request.signal)
          return json({ ...value, cached: true })
        }
        // Native counters are per Cloudflare location; the app credential enforces its overall budget.
        if (!(await env.GLOBAL_LIMIT.limit({ key: 'chess-lm:all' })).success) return json({ error: 'The coach is busy. Please try again shortly.' }, 429, { 'retry-after': '60' })
        const result = await withDeadline(request.signal, timeoutMs, async (signal) => {
          await featuredModel(model, env, cache, url.origin, ctx, signal, logger)
          return requestGatewayCoach(position, { gateway: env.GATEWAY, apiKey: env.CAIL_GATEWAY_KEY, model, signal })
        })
        cachePut(cache, key, result, 600, ctx, logger)
        logger.info?.(JSON.stringify({ event: 'chess_coach_completed', model: result.model, ms: Date.now() - startedAt }))
        return json({ ...result, cached: false })
      } catch (error) {
        if (error instanceof CoachInputError) return json({ error: error.message }, 400)
        if (error instanceof CoachServiceError) {
          logger.warn?.(JSON.stringify({ event: 'chess_coach_failed', status: error.status, upstreamStatus: error.upstreamStatus, ms: Date.now() - startedAt }))
          return json({ error: error.message }, error.status, error.status === 429 ? { 'retry-after': '60' } : {})
        }
        logger.warn?.(JSON.stringify({ event: 'chess_coach_failed', status: 502, ms: Date.now() - startedAt }))
        return json({ error: 'The coach could not finish this reading. Please try again.' }, 502)
      }
    },
  }
}

export default createWorker()
