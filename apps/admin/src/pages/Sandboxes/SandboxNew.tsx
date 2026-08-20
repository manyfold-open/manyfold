import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Button, Card, CardBody, Heading, Input } from '@/ui'

const SandboxNew: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [name, setName] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const canSubmit = !submitting && name.trim().length > 0

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        try {
            await client.sandboxes.create({ name: name.trim() })
            navigate(adminRoutes.sandboxes)
        } catch (err) {
            setError((err as Error).message)
            setSubmitting(false)
        }
    }

    return (
        <div className='mx-auto max-w-xl space-y-3'>
            <Heading level={1}>New sandbox</Heading>
            <p className='text-caption text-body'>
                Provisions an empty sandbox VM. It runs without an agent — attach
                agents to it later when creating them.
            </p>
            {error && (
                <Card elevation='ambient' className='border-accent-ruby/30'>
                    <pre className='text-accent-ruby text-caption-sm p-2'>
                        {error}
                    </pre>
                </Card>
            )}
            <Card elevation='ambient'>
                <CardBody>
                    <form
                        onSubmit={(e): void => void submit(e)}
                        className='space-y-3'
                    >
                        <div className='space-y-1'>
                            <label
                                htmlFor='sandbox-name'
                                className='text-caption-sm text-label'
                            >
                                Name
                            </label>
                            <Input
                                id='sandbox-name'
                                value={name}
                                onChange={(e): void => setName(e.target.value)}
                                placeholder='my-sandbox'
                                maxLength={64}
                            />
                        </div>
                        <div className='flex gap-2'>
                            <Button type='submit' disabled={!canSubmit}>
                                {submitting ? 'Creating…' : 'Create sandbox'}
                            </Button>
                            <Button
                                type='button'
                                variant='ghost'
                                onClick={(): void =>
                                    navigate(adminRoutes.sandboxes)
                                }
                            >
                                Cancel
                            </Button>
                        </div>
                    </form>
                </CardBody>
            </Card>
        </div>
    )
}

export default SandboxNew