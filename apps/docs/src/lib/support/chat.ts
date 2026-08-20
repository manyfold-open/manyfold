import {
    clearError,
    getState,
    init,
    newChat,
    rate,
    retry,
    send,
    stop,
    subscribe,
    type Message,
    type SupportState
} from './conversation'
import { readPageContext } from './difyClient'
import { renderMarkdown } from './markdown'
import { resolveSources, type ResolvedSource } from './sources'

const BOTTOM_SLACK_PX = 40

const escapeHtml = (value: string): string =>
    value.replace(
        /[&<>"]/g,
        (char) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;'
            })[char] ?? char
    )

const ICON_LIKE =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Z"/><path d="M7 10l4.2-7a2 2 0 0 1 3.7 1.3L14 9h4.7a2 2 0 0 1 2 2.5l-1.8 7A2 2 0 0 1 17 20H7"/></svg>'
const ICON_DISLIKE =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Z"/><path d="M17 14l-4.2 7a2 2 0 0 1-3.7-1.3L10 15H5.3a2 2 0 0 1-2-2.5l1.8-7A2 2 0 0 1 7 4h10"/></svg>'

type View = {
    root: HTMLElement
    transcript: HTMLElement
    status: HTMLElement
    form: HTMLFormElement
    textarea: HTMLTextAreaElement
    sendButton: HTMLButtonElement
    stopButton: HTMLButtonElement
    newChatButton: HTMLButtonElement | null
    jump: HTMLButtonElement
    empty: HTMLElement
    pinned: boolean
}

const copyOf = (root: HTMLElement, key: string): string =>
    root.dataset[key] ?? ''

const sourceCache = new Map<string, ResolvedSource[]>()

const sourcesKey = (message: Message): string =>
    message.sources.map((source) => source.document_name ?? '').join('|')

const renderSources = (
    view: View,
    message: Message,
    index: number
): string => {
    const locale = view.root.dataset.locale ?? 'en'
    const key = `${locale}:${sourcesKey(message)}`
    if (!sourcesKey(message)) return ''
    const resolved = sourceCache.get(key)
    if (!resolved) {
        void resolveSources(message.sources, locale).then((next) => {
            sourceCache.set(key, next)
            render(view)
        })
        return ''
    }
    if (!resolved.length) return ''
    const unavailable = copyOf(view.root, 'copySourceUnavailable')
    const chips = resolved
        .map((source) => {
            const label = escapeHtml(source.title)
            if (!source.href)
                return `<span class="docs-support-source is-missing" title="${escapeHtml(unavailable)}">${label}</span>`
            return `<a class="docs-support-source" href="${source.href}">${label}</a>`
        })
        .join('')
    return `<div class="docs-support-sources" data-for="${index}"><span class="docs-support-sources-label">${escapeHtml(
        copyOf(view.root, 'copySourcesLabel')
    )}</span>${chips}</div>`
}

const renderFeedback = (view: View, message: Message, index: number): string => {
    if (!message.messageId || message.streaming) return ''
    const like = escapeHtml(copyOf(view.root, 'copyFeedbackLike'))
    const dislike = escapeHtml(copyOf(view.root, 'copyFeedbackDislike'))
    return `<div class="docs-support-feedback">
        <button type="button" class="docs-support-rate${message.rating === 'like' ? ' is-active' : ''}" data-rate="like" data-index="${index}" aria-pressed="${message.rating === 'like'}">${ICON_LIKE}<span class="sr-only">${like}</span></button>
        <button type="button" class="docs-support-rate${message.rating === 'dislike' ? ' is-active' : ''}" data-rate="dislike" data-index="${index}" aria-pressed="${message.rating === 'dislike'}">${ICON_DISLIKE}<span class="sr-only">${dislike}</span></button>
    </div>`
}

const renderMessage = (view: View, message: Message, index: number): string => {
    if (message.role === 'user')
        return `<div class="docs-support-msg is-user"><div class="docs-support-bubble">${escapeHtml(
            message.text
        )}</div></div>`

    const thinking =
        message.streaming && !message.text
            ? `<p class="docs-support-thinking"><span class="docs-support-dots" aria-hidden="true"></span>${escapeHtml(
                  copyOf(view.root, 'copyThinking')
              )}</p>`
            : ''
    const body = message.text
        ? `<div class="docs-support-answer">${renderMarkdown(message.text)}</div>`
        : ''
    const stopped = message.stopped
        ? `<p class="docs-support-note">${escapeHtml(copyOf(view.root, 'copyStopped'))}</p>`
        : ''
    return `<div class="docs-support-msg is-agent">${thinking}${body}${stopped}${renderSources(
        view,
        message,
        index
    )}${renderFeedback(view, message, index)}</div>`
}

const announcementText = (view: View, state: SupportState): string => {
    switch (state.announcement) {
        case 'answering':
            return copyOf(view.root, 'copySrAnswering')
        case 'ready':
            return copyOf(view.root, 'copySrAnswerReady')
        case 'stopped':
            return copyOf(view.root, 'copySrStopped')
        case 'error':
            return copyOf(view.root, 'copyErrorGeneric')
        default:
            return ''
    }
}

const errorText = (view: View, state: SupportState): string => {
    if (state.error === 'offline') return copyOf(view.root, 'copyErrorOffline')
    if (state.error === 'unavailable')
        return copyOf(view.root, 'copyErrorUnavailable')
    if (state.error) return copyOf(view.root, 'copyErrorGeneric')
    return ''
}

const atBottom = (node: HTMLElement): boolean =>
    node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK_PX

const render = (view: View): void => {
    const state = getState()
    const wasPinned = view.pinned

    view.empty.hidden = state.messages.length > 0
    const rows = state.messages
        .map((message, index) => renderMessage(view, message, index))
        .join('')
    const error = errorText(view, state)
    const errorRow = error
        ? `<div class="docs-support-error" role="alert"><span>${escapeHtml(error)}</span><button type="button" class="docs-support-retry" data-retry>${escapeHtml(
              copyOf(view.root, 'copyRetry')
          )}</button></div>`
        : ''
    view.transcript.innerHTML = rows + errorRow

    view.status.textContent = announcementText(view, state)
    view.sendButton.hidden = state.streaming
    view.stopButton.hidden = !state.streaming
    view.textarea.disabled = state.status === 'unavailable'
    if (view.newChatButton) view.newChatButton.hidden = !state.messages.length

    if (wasPinned) {
        view.transcript.scrollTop = view.transcript.scrollHeight
        view.jump.hidden = true
    } else {
        view.jump.hidden = atBottom(view.transcript)
    }
}

const autosize = (textarea: HTMLTextAreaElement): void => {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
}

const mountRoot = (root: HTMLElement): void => {
    if (root.dataset.mounted) return
    root.dataset.mounted = '1'

    const query = <T extends HTMLElement>(selector: string): T =>
        root.querySelector(selector) as T

    const view: View = {
        root,
        transcript: query('[data-support-transcript]'),
        status: query('[data-support-status]'),
        form: query<HTMLFormElement>('[data-support-form]'),
        textarea: query<HTMLTextAreaElement>('[data-support-input]'),
        sendButton: query<HTMLButtonElement>('[data-support-send]'),
        stopButton: query<HTMLButtonElement>('[data-support-stop]'),
        newChatButton: root.querySelector('[data-support-new]'),
        jump: query<HTMLButtonElement>('[data-support-jump]'),
        empty: query('[data-support-empty]'),
        pinned: true
    }

    const context = () => readPageContext(root.dataset.locale ?? 'en')

    let composing = false
    view.textarea.addEventListener('compositionstart', () => {
        composing = true
    })
    view.textarea.addEventListener('compositionend', () => {
        composing = false
    })
    view.textarea.addEventListener('input', () => autosize(view.textarea))
    view.textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return
        // Enter during IME composition is the commit key, not "send".
        if (composing || event.isComposing) return
        event.preventDefault()
        view.form.requestSubmit()
    })

    view.form.addEventListener('submit', (event) => {
        event.preventDefault()
        const text = view.textarea.value
        if (!text.trim()) return
        view.textarea.value = ''
        autosize(view.textarea)
        view.pinned = true
        void send(text, context())
    })

    view.stopButton.addEventListener('click', () => stop())
    view.newChatButton?.addEventListener('click', () => {
        newChat()
        view.pinned = true
        view.textarea.focus()
    })

    view.jump.addEventListener('click', () => {
        view.pinned = true
        view.transcript.scrollTop = view.transcript.scrollHeight
        view.jump.hidden = true
    })

    view.transcript.addEventListener('scroll', () => {
        view.pinned = atBottom(view.transcript)
        view.jump.hidden = view.pinned
    })

    view.transcript.addEventListener('click', (event) => {
        const target = event.target as HTMLElement
        const rateButton = target.closest<HTMLElement>('[data-rate]')
        if (rateButton) {
            const index = Number(rateButton.dataset.index)
            const rating = rateButton.dataset.rate === 'like' ? 'like' : 'dislike'
            void rate(index, rating)
            return
        }
        if (target.closest('[data-retry]')) {
            clearError()
            view.pinned = true
            void retry(context())
        }
    })

    root.querySelectorAll<HTMLElement>('[data-support-starter]').forEach((chip) =>
        chip.addEventListener('click', () => {
            view.pinned = true
            void send(chip.textContent ?? '', context())
        })
    )

    subscribe(() => render(view))
    render(view)
}

export const mountSupportChat = (): void => {
    document
        .querySelectorAll<HTMLElement>('[data-support-root]')
        .forEach(mountRoot)
    void init()
}