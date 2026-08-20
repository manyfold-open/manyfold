import type { FC, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Plus } from 'lucide-react'
import {
    ClaudeCodeColor,
    CodexColor,
    GeminiCLIColor,
    HermesAgentMono,
    OpenClawColor,
    type IconType
} from '@/lib/brandIcons'
import { useI18n } from '@/lib/i18n'

const BrandAvatar: FC<{ icon: IconType }> = ({ icon: Icon }) => (
    <Icon aria-hidden='true' />
)

interface DemoAgent {
    cls: string
    name: string
    framework: string
    icon: IconType
}

const DEMO_AGENTS: DemoAgent[] = [
    {
        cls: 'lp-a1',
        name: 'refactor-bot',
        framework: 'Claude Code',
        icon: ClaudeCodeColor
    },
    {
        cls: 'lp-a2',
        name: 'pr-reviewer',
        framework: 'Codex',
        icon: CodexColor
    },
    {
        cls: 'lp-a3',
        name: 'research-mate',
        framework: 'Gemini CLI',
        icon: GeminiCLIColor
    },
    {
        cls: 'lp-a4',
        name: 'data-digger',
        framework: 'Openclaw',
        icon: OpenClawColor
    },
    {
        cls: 'lp-rest',
        name: 'ops-runner',
        framework: 'Hermes',
        icon: HermesAgentMono
    },
    {
        cls: 'lp-rest',
        name: 'test-writer',
        framework: 'Claude Code',
        icon: ClaudeCodeColor
    }
]

interface DemoScene {
    cls: string
    name: string
    framework: string
    icon: IconType
    step1Key: string
    step2Key: string
    thinkingKey: string
    resultPrefixKey: string
    resultAccent: string
    resultSuffixKey: string
    promptKey: string
}

const DEMO_SCENES: DemoScene[] = [
    {
        cls: 'lp-s1',
        name: 'refactor-bot',
        framework: 'Claude Code',
        icon: ClaudeCodeColor,
        step1Key: 'web.landing.demoScene1Step1',
        step2Key: 'web.landing.demoScene1Step2',
        thinkingKey: 'web.landing.demoScene1Thinking',
        resultPrefixKey: 'web.landing.demoScene1ResultPrefix',
        resultAccent: '',
        resultSuffixKey: 'web.landing.demoScene1ResultSuffix',
        promptKey: 'web.landing.demoScene1Prompt'
    },
    {
        cls: 'lp-s2',
        name: 'pr-reviewer',
        framework: 'Codex',
        icon: CodexColor,
        step1Key: 'web.landing.demoScene2Step1',
        step2Key: 'web.landing.demoScene2Step2',
        thinkingKey: 'web.landing.demoScene2Thinking',
        resultPrefixKey: 'web.landing.demoScene2ResultPrefix',
        resultAccent: '',
        resultSuffixKey: 'web.landing.demoScene2ResultSuffix',
        promptKey: 'web.landing.demoScene2Prompt'
    },
    {
        cls: 'lp-s3',
        name: 'research-mate',
        framework: 'Gemini CLI',
        icon: GeminiCLIColor,
        step1Key: 'web.landing.demoScene3Step1',
        step2Key: 'web.landing.demoScene3Step2',
        thinkingKey: 'web.landing.demoScene3Thinking',
        resultPrefixKey: 'web.landing.demoScene3ResultPrefix',
        resultAccent: '',
        resultSuffixKey: 'web.landing.demoScene3ResultSuffix',
        promptKey: 'web.landing.demoScene3Prompt'
    },
    {
        cls: 'lp-s4',
        name: 'data-digger',
        framework: 'Openclaw',
        icon: OpenClawColor,
        step1Key: 'web.landing.demoScene4Step1',
        step2Key: 'web.landing.demoScene4Step2',
        thinkingKey: 'web.landing.demoScene4Thinking',
        resultPrefixKey: 'web.landing.demoScene4ResultPrefix',
        resultAccent: '',
        resultSuffixKey: 'web.landing.demoScene4ResultSuffix',
        promptKey: 'web.landing.demoScene4Prompt'
    }
]

type StepStatus = 'pending' | 'active' | 'done'

const SCENE_DURATION_MS = 5500
const STEP_TIMINGS_MS: ReadonlyArray<number> = [700, 1700, 3000]
const RESULT_DELAY_MS = 3000

const initialStepStatuses: ReadonlyArray<StepStatus> = [
    'pending',
    'pending',
    'pending'
]

const TILT_SCROLL_RANGE_PX = 120
const TILT_FOLLOW_LERP = 0.08

// Scroll-driven 3D tilt on the demo panel. Attach to the page root that
// wraps a `.lp-product-demo-tilt` element; no-ops under reduced motion.
// `demoMounted` re-arms the effect when the demo appears late: the classic
// hero (which hosts .lp-product-demo-tilt) only mounts on the first fold, so
// a mount-time-only query would never find it.
export const useProductDemoTilt = (
    rootRef: RefObject<HTMLElement | null>,
    demoMounted = true
): void => {
    useEffect(() => {
        if (!demoMounted) return
        const root = rootRef.current
        if (!root) return
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return
        }

        root.dataset.tiltEnabled = 'true'
        const tilt = root.querySelector<HTMLElement>('.lp-product-demo-tilt')
        if (!tilt) return

        let target = 0
        let current = 0
        let rafId = 0
        let running = false

        const readTarget = () => {
            const y = window.scrollY
            target = Math.min(1, Math.max(0, y / TILT_SCROLL_RANGE_PX))
        }

        const tick = () => {
            const diff = target - current
            if (Math.abs(diff) < 0.0005) {
                current = target
                tilt.style.setProperty('--tilt-progress', current.toFixed(4))
                running = false
                return
            }
            current += diff * TILT_FOLLOW_LERP
            tilt.style.setProperty('--tilt-progress', current.toFixed(4))
            rafId = window.requestAnimationFrame(tick)
        }

        const onScroll = () => {
            readTarget()
            if (!running) {
                running = true
                rafId = window.requestAnimationFrame(tick)
            }
        }

        readTarget()
        current = target
        tilt.style.setProperty('--tilt-progress', current.toFixed(4))

        window.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            window.removeEventListener('scroll', onScroll)
            if (rafId) window.cancelAnimationFrame(rafId)
            delete root.dataset.tiltEnabled
        }
    }, [rootRef, demoMounted])
}

export const ProductDemo: FC = (): ReactNode => {
    const { t } = useI18n()
    const [activeIndex, setActiveIndex] = useState(0)
    const [stepStatuses, setStepStatuses] =
        useState<ReadonlyArray<StepStatus>>(initialStepStatuses)
    const [resultVisible, setResultVisible] = useState(false)
    const railListRef = useRef<HTMLDivElement | null>(null)
    const agentRefs = useRef<Array<HTMLDivElement | null>>([])

    useEffect(() => {
        if (
            typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ) {
            setStepStatuses(['done', 'done', 'done'])
            setResultVisible(true)
            return
        }

        setStepStatuses(['active', 'pending', 'pending'])
        setResultVisible(false)

        const timers: ReadonlyArray<number> = [
            window.setTimeout(() => {
                setStepStatuses(['done', 'active', 'pending'])
            }, STEP_TIMINGS_MS[0]),
            window.setTimeout(() => {
                setStepStatuses(['done', 'done', 'active'])
            }, STEP_TIMINGS_MS[1]),
            window.setTimeout(() => {
                setStepStatuses(['done', 'done', 'done'])
            }, STEP_TIMINGS_MS[2]),
            window.setTimeout(() => {
                setResultVisible(true)
            }, RESULT_DELAY_MS),
            window.setTimeout(() => {
                setActiveIndex((current) => (current + 1) % DEMO_SCENES.length)
            }, SCENE_DURATION_MS)
        ]

        return () => {
            timers.forEach((id) => window.clearTimeout(id))
        }
    }, [activeIndex])

    const activeScene = DEMO_SCENES[activeIndex]
    const activeAgentName = activeScene.name
    const activeAgentIndex = DEMO_AGENTS.findIndex(
        (agent) => agent.name === activeAgentName
    )

    useEffect(() => {
        if (activeAgentIndex < 0) return

        const focus = (): void => {
            const list = railListRef.current
            const item = agentRefs.current[activeAgentIndex]
            if (!list || !item) return

            const reduce = window.matchMedia?.(
                '(prefers-reduced-motion: reduce)'
            ).matches
            const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth'

            const isHorizontal = list.scrollWidth > list.clientWidth + 1
            if (isHorizontal) {
                const target =
                    item.offsetLeft - (list.clientWidth - item.clientWidth) / 2
                list.scrollTo({ left: Math.max(0, target), behavior })
            } else if (list.scrollHeight > list.clientHeight + 1) {
                const target =
                    item.offsetTop - (list.clientHeight - item.clientHeight) / 2
                list.scrollTo({ top: Math.max(0, target), behavior })
            }
        }

        const raf = window.requestAnimationFrame(focus)
        return () => window.cancelAnimationFrame(raf)
    }, [activeAgentIndex])

    const stepDefs = [
        { textKey: activeScene.step1Key, withCaret: false },
        { textKey: activeScene.step2Key, withCaret: false },
        { textKey: activeScene.thinkingKey, withCaret: true }
    ]

    return (
        <div className='lp-product-demo' aria-hidden='true'>
            <div className='lp-pd-body'>
                <aside className='lp-pd-rail'>
                    <div className='lp-pd-rail-head'>
                        <span className='lp-label'>
                            {t('web.landing.demoAgentsLabel')}
                        </span>
                        <span className='lp-count'>{DEMO_AGENTS.length}</span>
                    </div>
                    <div className='lp-pd-rail-list' ref={railListRef}>
                        {DEMO_AGENTS.map((agent, index) => {
                            const isActive = agent.name === activeAgentName
                            const isQueued = agent.cls === 'lp-rest'
                            return (
                                <div
                                    key={`${agent.name}-${index}`}
                                    ref={(node) => {
                                        agentRefs.current[index] = node
                                    }}
                                    className='lp-pd-agent'
                                    data-state={
                                        isActive
                                            ? 'active'
                                            : isQueued
                                              ? 'queued'
                                              : 'idle'
                                    }
                                >
                                    <span className='lp-pd-agent-avatar'>
                                        <BrandAvatar icon={agent.icon} />
                                    </span>
                                    <div className='lp-pd-agent-body'>
                                        <div className='lp-pd-agent-name'>
                                            {agent.name}
                                        </div>
                                        <div className='lp-pd-agent-meta'>
                                            {agent.framework}
                                        </div>
                                    </div>
                                    <span className='lp-pd-agent-dot' />
                                </div>
                            )
                        })}
                    </div>
                </aside>
                <section className='lp-pd-canvas'>
                    <div className='lp-pd-canvas-label'>
                        <span className='lp-live-dot' />
                        <span>{t('web.landing.demoNowWorking')}</span>
                    </div>
                    <div className='lp-pd-stage'>
                        <div className='lp-pd-scene' key={activeIndex}>
                            <div className='lp-pd-scene-head'>
                                <span className='lp-av'>
                                    <BrandAvatar icon={activeScene.icon} />
                                </span>
                                <div className='lp-copy'>
                                    <span className='lp-nm'>
                                        {activeScene.name}
                                    </span>
                                    <span className='lp-fw'>
                                        {activeScene.framework}
                                    </span>
                                </div>
                            </div>
                            <ol className='lp-pd-steps'>
                                {stepDefs.map((step, stepIndex) => {
                                    const status = stepStatuses[stepIndex]
                                    return (
                                        <li
                                            key={stepIndex}
                                            className='lp-pd-step'
                                            data-status={status}
                                        >
                                            <span className='lp-pd-step-mark'>
                                                <span className='lp-pd-mark-dot' />
                                                <span className='lp-pd-mark-spin' />
                                                <span className='lp-pd-mark-check'>
                                                    <Check />
                                                </span>
                                            </span>
                                            <span className='lp-pd-step-text'>
                                                {t(step.textKey)}
                                                {step.withCaret &&
                                                status === 'active' ? (
                                                    <span className='lp-pd-step-caret' />
                                                ) : null}
                                            </span>
                                        </li>
                                    )
                                })}
                            </ol>
                            <div
                                className='lp-pd-scene-result'
                                data-visible={resultVisible ? 'true' : 'false'}
                            >
                                <span className='lp-check'>
                                    <Check />
                                </span>
                                <span>
                                    {t(activeScene.resultPrefixKey)}{' '}
                                    {activeScene.resultAccent ? (
                                        <>
                                            <span className='lp-accent'>
                                                {activeScene.resultAccent}
                                            </span>{' '}
                                        </>
                                    ) : null}
                                    {t(activeScene.resultSuffixKey)}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className='lp-pd-composer'>
                        <span className='lp-pd-composer-attach'>
                            <Plus />
                        </span>
                        <div className='lp-pd-composer-stack'>
                            <span className='lp-pd-composer-empty'>
                                <span className='lp-pd-composer-caret' />
                            </span>
                        </div>
                        <span className='lp-pd-composer-send'>
                            <ArrowUp />
                        </span>
                    </div>
                </section>
            </div>
        </div>
    )
}
