import { SpritesProvider } from '../../src/modules/hosts/providers/sprites.provider'

// The power sync reaches every provider through its adapter. These tests
// drive the real sprites adapter over a fake sprites.dev client, so what they
// prove covers the listing's mapping as well as the sync's decisions.
export const spritesResolver = (
    client: unknown,
    provider: Record<string, unknown> = {
        id: 'acc-1',
        kind: 'sprites',
        name: 'acct'
    }
) => {
    const adapter = new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        {
            spritesClientForProvider: () => client,
            spritesLoggerFor: () => ({
                debug() {},
                info() {},
                warn() {},
                error() {}
            })
        } as never
    )
    return {
        adapter,
        resolver: {
            resolve: async () => ({ provider, adapter }),
            adapterFor: () => adapter,
            adapters: () => [adapter]
        }
    }
}
