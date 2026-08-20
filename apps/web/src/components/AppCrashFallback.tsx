import type { FC } from 'react'
import { t } from '@manyfold/i18n'

// Rendered when a route subtree throws. It deliberately depends on nothing but
// CSS tokens and t(): whatever crashed may well be a provider above it.
const AppCrashFallback: FC = () => (
    <div
        role='alert'
        className='bg-main flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center'
    >
        <h1 className='text-fg text-lg font-medium'>
            {t('errors.appCrash.title')}
        </h1>
        <p className='text-muted max-w-prose text-sm'>
            {t('errors.appCrash.body')}
        </p>
        <button
            type='button'
            className='border-divider bg-soft text-fg hover:bg-soft-hover rounded-md border px-4 py-2 text-sm'
            onClick={() => window.location.reload()}
        >
            {t('errors.appCrash.reload')}
        </button>
    </div>
)

export default AppCrashFallback