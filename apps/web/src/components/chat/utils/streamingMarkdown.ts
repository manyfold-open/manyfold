import katex from 'katex'
import remend, { type RemendOptions } from 'remend'

// While streaming, close half-typed markers (**, `, ~~, $$, …) before parsing so
// incomplete syntax never flashes as literal text. inlineKatex stays off to match
// remark-math's singleDollarTextMath:false (a lone $ is prose, not math); an
// incomplete link renders as plain text instead of a placeholder href we'd show.
const HEAL_OPTIONS: RemendOptions = {
    inlineKatex: false,
    linkMode: 'text-only'
}

export const healMarkdownSpan = (text: string): string =>
    remend(text, HEAL_OPTIONS)

// remend closes a dangling $$, but the formula inside can still be mid-command
// (e.g. `$$\frac{1}{`), which KaTeX rejects. Probe the trailing display-math span
// so the caller can hold the last renderable frame instead of flashing an error.
export const mathSpanRenderable = (formula: string): boolean => {
    if (!formula) return true
    try {
        katex.renderToString(formula, { displayMode: true, throwOnError: true })
        return true
    } catch {
        return false
    }
}
