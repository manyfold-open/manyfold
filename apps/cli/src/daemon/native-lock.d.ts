declare module 'fs-native-extensions' {
    export function tryLock(fd: number): boolean
}

declare module 'bun:ffi' {
    export function dlopen(
        path: string,
        symbols: Record<
            string,
            {
                args: readonly ('i32' | 'ptr')[]
                returns: 'i32' | 'ptr'
            }
        >
    ): { symbols: Record<string, (...args: number[]) => number> }
    export function ptr(buffer: Uint8Array): number
    export const read: { i32(pointer: number): number }
}
