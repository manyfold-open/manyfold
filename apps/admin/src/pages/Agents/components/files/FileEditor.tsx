import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { FilesClient } from '@manyfold/sdk'
import { Button } from '@/ui'
import { downloadEntry } from './downloadEntry'

interface FileEditorProps {
    filesApi: FilesClient
    agentId: string
    path: string
    size: number
    contentType: string
    rootId?: string
    writable?: boolean
    onSaved?: () => void
}

const MAX_EDIT_BYTES = 1_000_000

const isLikelyText = (contentType: string): boolean => {
    if (!contentType) return false
    if (contentType.startsWith('text/')) return true
    return /^(application\/(json|javascript|xml|x-sh|x-yaml|x-toml))|\+json|\+xml/.test(
        contentType
    )
}

const detectLanguage = async (path: string): Promise<Extension | null> => {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'md' || ext === 'markdown') {
        const m = await import('@codemirror/lang-markdown')
        return m.markdown()
    }
    if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
        const m = await import('@codemirror/lang-javascript')
        return m.javascript({
            jsx: ext !== 'js' && ext !== 'mjs' && ext !== 'cjs' ? true : false
        })
    }
    if (['ts', 'tsx'].includes(ext)) {
        const m = await import('@codemirror/lang-javascript')
        return m.javascript({ typescript: true, jsx: ext === 'tsx' })
    }
    if (ext === 'json') {
        const m = await import('@codemirror/lang-json')
        return m.json()
    }
    if (ext === 'yaml' || ext === 'yml') {
        const m = await import('@codemirror/lang-yaml')
        return m.yaml()
    }
    if (ext === 'py') {
        const m = await import('@codemirror/lang-python')
        return m.python()
    }
    if (ext === 'html' || ext === 'htm') {
        const m = await import('@codemirror/lang-html')
        return m.html()
    }
    if (ext === 'css') {
        const m = await import('@codemirror/lang-css')
        return m.css()
    }
    return null
}

export const FileEditor: FC<FileEditorProps> = ({
    filesApi,
    agentId,
    path,
    size,
    contentType,
    rootId,
    writable = true,
    onSaved
}): ReactNode => {
    const [doc, setDoc] = useState<string>('')
    const [initial, setInitial] = useState<string>('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [langExt, setLangExt] = useState<Extension[]>([])
    const dirty = doc !== initial
    const tooBig = size > MAX_EDIT_BYTES
    const looksText = isLikelyText(contentType)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        if (tooBig || !looksText) {
            setLoading(false)
            return (): void => {
                cancelled = true
            }
        }
        ;(async () => {
            try {
                const res = await filesApi.read(
                    agentId,
                    path,
                    rootId ? { rootId } : undefined
                )
                const text = await res.text()
                if (cancelled) return
                setDoc(text)
                setInitial(text)
                const ext = await detectLanguage(path)
                if (cancelled) return
                setLangExt(ext ? [ext] : [])
            } catch (err) {
                if (!cancelled) setError((err as Error).message)
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return (): void => {
            cancelled = true
        }
    }, [filesApi, agentId, path, looksText, tooBig, rootId])

    const save = async (): Promise<void> => {
        setSaving(true)
        setError(null)
        try {
            const body = new Blob([doc], { type: 'application/octet-stream' })
            await filesApi.write(
                agentId,
                path,
                body,
                rootId ? { rootId } : undefined
            )
            setInitial(doc)
            onSaved?.()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSaving(false)
        }
    }

    const saveKeymap = useMemo<Extension>(
        () =>
            keymap.of([
                {
                    key: 'Mod-s',
                    run: () => {
                        if (dirty && !saving) void save()
                        return true
                    }
                }
            ]),
        [dirty, saving, doc]
    )

    const download = async (): Promise<void> => {
        try {
            await downloadEntry(filesApi, agentId, path, rootId)
        } catch (err) {
            setError((err as Error).message)
        }
    }

    if (tooBig || !looksText) {
        return (
            <div className='flex h-full flex-col items-center justify-center gap-3 p-2 text-center'>
                <p className='text-body text-sm'>
                    {tooBig
                        ? `File is ${(size / 1024 / 1024).toFixed(1)}MB — too large to edit inline (>${(MAX_EDIT_BYTES / 1024 / 1024).toFixed(0)}MB).`
                        : `${contentType || 'binary'} — not shown inline.`}
                </p>
                <Button variant='ghost' size='sm' onClick={download}>
                    Download
                </Button>
            </div>
        )
    }
    if (loading)
        return <p className='text-caption text-body p-2'>Loading {path}…</p>
    if (error)
        return (
            <p className='text-caption-sm text-accent-ruby p-2'>
                Error: {error}
            </p>
        )

    return (
        <div className='flex h-full flex-col'>
            <div className='border-border bg-surface-muted flex items-center justify-between border-b px-3 py-2'>
                <span className='text-caption-sm text-body truncate'>
                    {path}
                    {dirty ? ' •' : ''}
                </span>
                <div className='flex gap-2'>
                    <Button variant='ghost' size='sm' onClick={download}>
                        Download
                    </Button>
                    <Button
                        variant='primary'
                        size='sm'
                        disabled={!dirty || saving || !writable}
                        onClick={save}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </div>
            <div className='min-h-0 flex-1 overflow-auto'>
                <CodeMirror
                    value={doc}
                    onChange={setDoc}
                    extensions={[
                        ...langExt,
                        EditorView.lineWrapping,
                        saveKeymap
                    ]}
                    basicSetup={{
                        lineNumbers: true,
                        foldGutter: true,
                        highlightActiveLine: true,
                        autocompletion: false
                    }}
                />
            </div>
        </div>
    )
}
