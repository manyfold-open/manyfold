import type { BuiltInProviderEntry, InferenceProtocol } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { BuiltInLogo } from '@/components/BuiltInProviderLogo'
import type { CreateMenuOption } from '@/components/CreateMenu'
import { PlusIcon } from '@/components/icons'
import {
    BuiltInProviderForm,
    CustomProviderForm
} from '@/components/ModelProviderForms'
import ProductDialog from '@/components/ProductDialog'
import { useI18n, type TFn } from '@/lib/i18n'

export type ModelProviderCreatePick =
    | { kind: 'builtin'; entry: BuiltInProviderEntry }
    | { kind: 'custom'; protocols: readonly InferenceProtocol[] }

// The rows of an "add a model provider" menu for a given catalog subset:
// the same shape the settings rail uses, so a provider added from the
// agent-create form is the one the settings page would have made.
export const modelProviderCreateOptions = (
    t: TFn,
    entries: readonly BuiltInProviderEntry[],
    customProtocols: readonly InferenceProtocol[],
    onPick: (pick: ModelProviderCreatePick) => void
): CreateMenuOption[] => [
    ...entries.map((entry) => ({
        key: entry.id,
        lead: <BuiltInLogo entry={entry} />,
        label: entry.label,
        onSelect: () => onPick({ kind: 'builtin', entry })
    })),
    {
        key: 'custom-new',
        icon: PlusIcon,
        label: t('web.modelProviders.customProvider'),
        onSelect: () => onPick({ kind: 'custom', protocols: customProtocols })
    }
]

// The settings page's built-in / custom setup views, hosted in a dialog so
// a form that needs a provider can add one without leaving.
const ModelProviderCreateDialog: FC<{
    pick: ModelProviderCreatePick
    onClose: () => void
    onCreated: (id: string) => void | Promise<void>
}> = ({ pick, onClose, onCreated }): ReactNode => {
    const { t } = useI18n()
    const created = (id: string): void => {
        void onCreated(id)
    }
    return (
        <ProductDialog
            size='md'
            title={
                pick.kind === 'builtin'
                    ? pick.entry.label
                    : t('web.modelProviders.createCustom')
            }
            description={
                pick.kind === 'builtin'
                    ? pick.entry.description
                    : t('web.modelProviders.createCustomDescription')
            }
            onClose={onClose}
        >
            {pick.kind === 'builtin' ? (
                <BuiltInProviderForm entry={pick.entry} onCreated={created} />
            ) : (
                <CustomProviderForm
                    protocols={pick.protocols}
                    onCreated={created}
                />
            )}
        </ProductDialog>
    )
}

export default ModelProviderCreateDialog
