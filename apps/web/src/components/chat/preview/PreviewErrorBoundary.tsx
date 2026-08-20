import type { ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'

interface PreviewErrorBoundaryProps {
    fallback: ReactNode
    children: ReactNode
}

interface PreviewErrorBoundaryState {
    failed: boolean
}

class PreviewErrorBoundary extends Component<
    PreviewErrorBoundaryProps,
    PreviewErrorBoundaryState
> {
    state: PreviewErrorBoundaryState = { failed: false }

    static getDerivedStateFromError(): PreviewErrorBoundaryState {
        return { failed: true }
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('workspace file preview crashed', error, info)
    }

    render(): ReactNode {
        return this.state.failed ? this.props.fallback : this.props.children
    }
}

export default PreviewErrorBoundary