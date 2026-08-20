import type { FC } from 'react'
import { t } from '@manyfold/i18n'

// Rendered when a route subtree throws. It deliberately depends on nothing but
// CSS tokens and t(): whatever crashed may well be a provider above it.
const AppCrashFallback: FC = () => (
    <div
        role='alert'
        className='bg-surface-muted flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center'
    >
        <h1 className='text-heading text-lg font-medium'>
            {t('errors.appCrash.title')}
        </h1>
        <p className='text-body max-w-prose text-sm'>
            {t('errors.appCrash.body')}
        </p>
        <button
            type='button'
            className='border-divider text-body hover:bg-surface rounded border px-4 py-2 text-sm transition-colors'
            onClick={() => window.location.reload()}
        >
            {t('errors.appCrash.reload')}
        </button>
    </div>
)

export default AppCrashFallback