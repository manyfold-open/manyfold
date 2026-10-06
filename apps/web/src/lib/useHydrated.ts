import { useEffect, useState } from 'react'

// False for the first render, the one a prerendered page is hydrated with
// (ADR-0042), and true from the next. For content the prerender leaves out
// on purpose.
export const useHydrated = (): boolean => {
    const [hydrated, setHydrated] = useState(false)
    useEffect(() => setHydrated(true), [])
    return hydrated
}
