// Cache Clock — host-side per-route prompt-cache TTL tracker.
//
// Listens to the host-wide post-commit `session/event` feed and pairs each
// session's latest `request/header` (route identity: provider/model) with the
// following `assistant/message` settlements that carry usage. For every route
// it records the wall-clock time of the last successful billed request — the
// moment the provider's prefix cache for that route was last refreshed.
//
// The web client receives the state through the forwarded `cache-clock/state`
// event (see packages/api/remotes remote-events allowlist): every change
// carries the FULL state snapshot (route, last billed time, configured TTL),
// so a freshly connected client self-heals within one heartbeat without a
// dedicated query method. TTL values are owner configuration (patch row
// `config`), resolved per route and shipped inside the snapshot.

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Loads the session event vocabulary (incl. `session/event`) into cordis Events.
import type {} from '@deepseek-ai/dsh-session'

/** Owner-facing TTL configuration (patch row `config`). */
export interface CacheClockConfig {
  /** Fallback TTL for routes without an explicit override (ms). */
  defaultTtlMs?: number
  /** Per-route TTL overrides keyed by `provider/model` (ms). */
  routeTtlMs?: Record<string, number | undefined>
}

/**
 * Default TTL fallback. Measured on real traffic (2026-10, zai-coding-cn GLM
 * routes): prefixes die between ~20 and ~60 minutes with a soft edge starting
 * around 20 minutes, so 20 minutes is the honest conservative default.
 */
export const DEFAULT_TTL_MS = 20 * 60_000

/** One route's last billed request, as observed from the durable log. */
export interface RouteCacheEntry {
  /** Route identity, `${provider}/${model}`. */
  readonly route: string
  /** Envelope time (epoch ms) of the last `assistant/message` with usage. */
  readonly at: number
  /** Cache-read tokens reported by that settlement, when present. */
  readonly cacheReadTokens?: number
  /** Configured TTL for this route (ms); the client counts down against it. */
  readonly ttlMs?: number
}

/** Immutable full-state payload carried by every `cache-clock/state` emission. */
export interface CacheClockState {
  readonly routes: readonly RouteCacheEntry[]
}

export class CacheClock extends Service {
  static inject = [] as const

  /** Validated owner configuration (patch row `config`). */
  static Config: z<CacheClockConfig> = z.object({
    defaultTtlMs: z.number(),
    routeTtlMs: z.dict(z.number()),
  }) as unknown as z<CacheClockConfig>

  private last = new Map<string, { at: number; cacheReadTokens?: number }>()
  /** Per-session fold of the latest effective request header. */
  private headers = new WeakMap<object, { provider: string; model: string }>()
  private readonly defaultTtlMs: number
  private readonly routeTtlMs: Record<string, number | undefined>

  /** Heartbeat period: bounds how long a connected client waits for a baseline. */
  private static readonly HEARTBEAT_MS = 60_000

  constructor(ctx: Context, config: CacheClockConfig = {}) {
    super(ctx, 'cacheClock')
    this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_TTL_MS
    this.routeTtlMs = config.routeTtlMs ?? {}
    // Self-heal baseline: even with no new settlements, connected clients get
    // the full snapshot at most one heartbeat after (re)connecting.
    const heartbeat = setInterval(() => this.publish(), CacheClock.HEARTBEAT_MS)
    ctx.effect(() => () => clearInterval(heartbeat), 'cache-clock: state heartbeat')
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const config = event.data.header.config
        if (config?.provider && config?.model) {
          this.headers.set(session, { provider: config.provider, model: config.model })
        }
        return
      }
      if (event.type !== 'assistant/message' || event.data.usage === undefined) return
      // Failed/cancelled attempts settle as usage-less `assistant/attempt`
      // records, so reaching here means the request was billed — the provider's
      // prefix cache for this route has just been touched (hit or rewritten).
      const header = this.headers.get(session)
      if (!header) return
      const route = `${header.provider}/${header.model}`
      const { cacheReadTokens } = event.data.usage
      this.last.set(route, cacheReadTokens === undefined
        ? { at: event.time }
        : { at: event.time, cacheReadTokens })
      this.publish()
    })
  }

  /** Resolved TTL for one route: explicit override, else the configured default. */
  ttlFor(route: string): number {
    return this.routeTtlMs[route] ?? this.defaultTtlMs
  }

  /** Current full snapshot, routes in first-seen order. */
  state(): CacheClockState {
    return {
      routes: [...this.last.entries()].map(([route, v]) => ({
        route,
        at: v.at,
        ttlMs: this.ttlFor(route),
        ...(v.cacheReadTokens === undefined ? {} : { cacheReadTokens: v.cacheReadTokens }),
      })),
    }
  }

  private publish(): void {
    // Fire-and-forget; the remotes allowlist forwards `emit` events to every
    // connected client. Payload is the complete snapshot (self-healing): a
    // freshly (re)connected client waits at most one heartbeat for state.
    this.ctx.emit('cache-clock/state', this.state())
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cacheClock: CacheClock
  }

  interface Events {
    /** Full per-route last-billed-request snapshot; emitted on every change. */
    'cache-clock/state'(state: CacheClockState): void
  }
}

export default CacheClock
