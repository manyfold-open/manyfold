import type { FC, ReactNode } from 'react'

// The label + control pairing every channel form uses. One copy, because the
// create page, the detail page's change-agent dialog and the edit page all
// render it and had drifted into three byte-identical definitions.
export const Field: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}) => (
    <label className='block'>
        <span className='text-ui text-fg mb-1 block font-medium'>{label}</span>
        {children}
    </label>
)
