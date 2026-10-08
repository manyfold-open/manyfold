// What Enter on a focused element does in this flow. It moves the flow on from
// a text field (the form convention) and from the row that is already picked
// (pick, then Enter), and nowhere else: on every other control Enter keeps its
// own meaning, so Back goes back and Change changes.
//
// Seen on staging [2026-10-08]: Enter was taken from every element on the
// page and the element's own click swallowed — Enter on Back moved the flow
// forward, and on step ④ Enter on a Change link would have created the agent.
export interface EnterTarget {
    tagName: string
    // An input's `type`; undefined for anything else.
    type?: string
    role: string | null
    ariaChecked: string | null
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', ''])

export const enterAdvances = (target: EnterTarget): boolean => {
    if (target.tagName === 'INPUT')
        return TEXT_INPUT_TYPES.has((target.type ?? '').toLowerCase())
    return target.role === 'radio' && target.ariaChecked === 'true'
}
