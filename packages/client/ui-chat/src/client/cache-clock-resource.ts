// Client face of the host Cache Clock: one resource protocol that turns the
// forwarded `cache-clock/state` event into a readable `dsh-resource://`
// address. The host payload is a FULL snapshot on every frame (change or
// self-heal heartbeat), so the provider needs no query method — it yields the
// first frame at most one heartbeat after a (re)connect and one frame per
// change afterwards.

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CacheClockState, RouteCacheEntry } from '@deepseek-ai/dsh-cache-clock'

export type { CacheClockState, RouteCacheEntry }

/** The one address carrying the host-wide per-route snapshot. Lower-case protocol: URL hosts fold case. */
export const CACHE_CLOCK_ADDRESS = 'dsh-resource://cache-clock/host'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Host-wide per-route last billed request snapshot (`dsh-cache-clock`). */
    'cache-clock': CacheClockState
  }
}

/**
 * Register the `cache-clock` resource provider on the client root context.
 * @param ctx - Client root context with `resources` and `remote` injected.
 * @returns The provider disposer (the registration's own).
 */
export function registerCacheClockResource(ctx: Context): () => void {
  return ctx.resources.register<'cache-clock'>({
    protocol: 'cache-clock',
    async *open(_address, { signal }): AsyncIterable<RemoteResult<CacheClockState>> {
      const frames: RemoteResult<CacheClockState>[] = []
      let notify = (): void => {}
      const off = ctx.remote.$on('cache-clock/state', (state) => {
        frames.push({ ok: true, value: state })
        notify()
      })
      signal.addEventListener('abort', () => {
        off()
        notify()
      }, { once: true })
      try {
        while (!signal.aborted) {
          let frame: RemoteResult<CacheClockState> | undefined
          while ((frame = frames.shift()) !== undefined) yield frame
          await new Promise<void>((resolve) => { notify = resolve })
        }
      } finally {
        off()
      }
    },
  })
}
