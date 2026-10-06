import type { FC, ReactNode } from 'react'

// A link that lands on one decision (approve a sign-in, grant access, confirm
// a deletion) renders ProductDialog's anatomy as the page itself, so the same
// decision reads the same whether it opens as a modal or from a link.
const DialogPage: FC<{
    title: ReactNode
    description?: ReactNode
    children?: ReactNode
    // Leads the action row on the left, e.g. the account being acted for.
    meta?: ReactNode
    actions?: ReactNode
}> = ({ title, description, children, meta, actions }): ReactNode => (
    <div className='text-fg bg-main flex min-h-screen items-center justify-center px-4 py-10'>
        <main className='workbench-panel w-full max-w-lg'>
            <header className='px-5 pt-5 pb-3 last:pb-5'>
                <h1 className='text-h2 text-fg'>{title}</h1>
                {description && (
                    <p className='text-ui text-muted mt-1.5'>{description}</p>
                )}
            </header>
            {children && (
                <div className='space-y-4 px-5 py-3 last:pb-5'>{children}</div>
            )}
            {actions && (
                <footer className='flex flex-wrap items-center justify-end gap-x-4 gap-y-3 px-5 pt-2 pb-5'>
                    {meta && (
                        <p className='text-caption text-subtle mr-auto min-w-0 break-all'>
                            {meta}
                        </p>
                    )}
                    <div className='flex gap-2'>{actions}</div>
                </footer>
            )}
        </main>
    </div>
)

export const VerificationCode: FC<{ label: string; code: string }> = ({
    label,
    code
}): ReactNode => (
    <div>
        <p className='text-ui text-fg'>{label}</p>
        <div className='bg-surface-subtle border-divider mt-2 rounded-sm border px-4 py-3 text-center font-mono text-xl font-medium'>
            {code}
        </div>
    </div>
)

export default DialogPage
