import { RefreshCw, RotateCw, WifiOff } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

export const ChatStreamRecoveryNotice = ({
    onReconnect,
    onReload
}: {
    onReconnect: () => void
    onReload: () => void
}) => {
    const { t } = useI18n()
    return (
        <div
            role='status'
            className='workbench-alert-warning flex flex-wrap items-center gap-3'
        >
            <WifiOff size={16} className='shrink-0' aria-hidden='true' />
            <span className='min-w-0 flex-1 basis-48'>
                {t('web.chatStream.connectionPaused')}
            </span>
            <div className='flex flex-wrap items-center gap-2'>
                <button
                    type='button'
                    className='workbench-button-secondary h-8 gap-1.5 px-3'
                    onClick={onReconnect}
                >
                    <RefreshCw size={14} aria-hidden='true' />
                    {t('web.chatStream.reconnect')}
                </button>
                <button
                    type='button'
                    className='workbench-button-secondary h-8 gap-1.5 px-3'
                    onClick={onReload}
                >
                    <RotateCw size={14} aria-hidden='true' />
                    {t('web.chatStream.reload')}
                </button>
            </div>
        </div>
    )
}
