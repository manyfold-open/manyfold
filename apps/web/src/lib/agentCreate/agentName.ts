import {
    agentNameAdjectives,
    agentNameAnimals
} from '@/pages/AgentNew/nameWords'

const randomNamePart = (items: readonly string[]): string =>
    items[Math.floor(Math.random() * items.length)]

const randomFourDigitSuffix = (): string =>
    Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, '0')

export const randomAgentName = (): string =>
    `${randomNamePart(agentNameAdjectives)}-${randomNamePart(agentNameAnimals)}-${randomFourDigitSuffix()}`
