import type { FC, ReactNode } from 'react'
import { HTML_PREVIEW_SANDBOX } from '@/components/chat/preview/previewKinds'

interface HtmlPreviewProps {
    html: string
    title: string
}

const HtmlPreview: FC<HtmlPreviewProps> = ({ html, title }): ReactNode => (
    <iframe
        srcDoc={html}
        title={title}
        // allow-scripts WITHOUT allow-same-origin: opaque origin keeps frame
        // scripts away from the parent DOM and auth session (previewKinds.test.ts)
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy='no-referrer'
        className='shadow-ring-light h-full min-h-[24rem] w-full rounded-md bg-white'
    />
)

export default HtmlPreview
