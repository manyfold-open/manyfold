import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'

interface Props {
    startedAt: number | null
    active: boolean
    thresholdMs?: number
}

const ElapsedTimer: FC<Props> = ({
    startedAt,
    active,
    thresholdMs = 0
}): ReactNode => {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!active || startedAt == null) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
    }, [active, startedAt])
    if (startedAt == null) return null
    if (now - startedAt < thresholdMs) return null
    return (
        <span className='font-mono tabular-nums'>
            · {formatElapsed(Math.max(0, now - startedAt))}
        </span>
    )
}

const formatElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60}s`
    return `${Math.floor(m / 60)}h ${m % 60}m`
}

export default ElapsedTimer
