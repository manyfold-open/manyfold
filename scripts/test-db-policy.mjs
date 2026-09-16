import fs from 'node:fs'
import path from 'node:path'

export function databaseModule(filename) {
    const normalized = filename.replaceAll('\\', '/').split('?')[0]
    if (/\/node_modules\/postgres\/(?:cjs\/)?src\/index\.js$/.test(normalized))
        return 'postgres'
    if (/\/node_modules\/pg\/lib\/index\.js$/.test(normalized)) return 'pg'
    if (
        /\/node_modules\/(?:pg\/lib\/client|pg-pool\/index)\.js$/.test(
            normalized
        )
    )
        return 'client'
    if (/\/node_modules\/dotenv\/lib\/main\.js$/.test(normalized))
        return 'dotenv'
    return null
}

export function databaseGuard({ allowDatabase, dotenvPath, logFile }) {
    const proxies = new WeakMap()
    const guarded = new WeakSet()
    const denied = (entry) => {
        fs.appendFileSync(logFile, `${entry}\n`)
        throw new Error(`sealed test env: forbidden ${entry}`)
    }
    const factory = (value, entry, validate = () => allowDatabase) => {
        if (typeof value !== 'function' || guarded.has(value)) return value
        if (proxies.has(value)) return proxies.get(value)
        const proxy = new Proxy(value, {
            apply(target, receiver, args) {
                if (!validate(args)) denied(entry)
                return Reflect.apply(target, receiver, args)
            },
            construct(target, args, receiver) {
                if (!validate(args)) denied(entry)
                return Reflect.construct(target, args, receiver)
            }
        })
        proxies.set(value, proxy)
        guarded.add(proxy)
        return proxy
    }
    return (value, kind) => {
        if (kind === 'postgres' || kind === 'client')
            return factory(value, `${kind} database factory`)
        if (
            !value ||
            (typeof value !== 'object' && typeof value !== 'function')
        )
            return value
        if (guarded.has(value)) return value
        if (proxies.has(value)) return proxies.get(value)
        const proxy = new Proxy(value, {
            get(target, property, receiver) {
                const result = Reflect.get(target, property, receiver)
                if (kind === 'pg' && ['Client', 'Pool'].includes(property))
                    return factory(result, `pg.${property} database factory`)
                if (
                    kind === 'dotenv' &&
                    ['config', 'configDotenv'].includes(property)
                )
                    return factory(
                        result,
                        `dotenv.${property} outside the sealed empty file`,
                        (args) => {
                            const selected = args[0]?.path
                            return Boolean(
                                dotenvPath &&
                                typeof selected === 'string' &&
                                path.resolve(selected) ===
                                    path.resolve(dotenvPath)
                            )
                        }
                    )
                return result
            }
        })
        proxies.set(value, proxy)
        guarded.add(proxy)
        return proxy
    }
}
