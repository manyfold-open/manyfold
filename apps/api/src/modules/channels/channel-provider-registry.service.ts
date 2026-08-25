import type { ChannelProviderName } from '@manyfold/shared'
import { BadRequestException, Injectable } from '@nestjs/common'
import type { ChannelProvider } from './channel-provider'
import { FakeChannelProvider } from './providers/fake.provider'
import { LarkChannelProvider } from './providers/lark.provider'
import { TelegramChannelProvider } from './providers/telegram.provider'
import { SlackChannelProvider } from './providers/slack.provider'
import { DiscordChannelProvider } from './providers/discord.provider'
import { MatrixChannelProvider } from './providers/matrix.provider'
import { WeixinChannelProvider } from './providers/weixin.provider'
import { WhatsappChannelProvider } from './providers/whatsapp.provider'
import { LinearChannelProvider } from './providers/linear.provider'
import { GithubChannelProvider } from './providers/github.provider'
import { LineChannelProvider } from './providers/line.provider'

@Injectable()
export class ChannelProviderRegistry {
    private readonly providers = new Map<ChannelProviderName, ChannelProvider>()

    constructor(
        fake: FakeChannelProvider,
        lark: LarkChannelProvider,
        telegram: TelegramChannelProvider,
        slack: SlackChannelProvider,
        discord: DiscordChannelProvider,
        matrix: MatrixChannelProvider,
        weixin: WeixinChannelProvider,
        whatsapp: WhatsappChannelProvider,
        linear: LinearChannelProvider,
        github: GithubChannelProvider,
        line: LineChannelProvider
    ) {
        this.providers.set('fake', fake)
        this.providers.set('lark', lark)
        this.providers.set('telegram', telegram)
        this.providers.set('slack', slack)
        this.providers.set('discord', discord)
        this.providers.set('matrix', matrix)
        this.providers.set('weixin', weixin)
        this.providers.set('whatsapp', whatsapp)
        this.providers.set('linear', linear)
        this.providers.set('github', github)
        this.providers.set('line', line)
    }

    get(name: ChannelProviderName): ChannelProvider {
        const provider = this.providers.get(name)
        if (!provider)
            throw new BadRequestException(`unsupported provider: ${name}`)
        return provider
    }

    list(): ChannelProvider[] {
        return Array.from(this.providers.values())
    }
}
