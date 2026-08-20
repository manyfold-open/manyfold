import { createTransport } from 'nodemailer'
import { Injectable, Logger } from '@nestjs/common'
import {
    EmailSettingsService,
    type ResolvedEmailProviderConfig
} from '@/modules/email/email-settings.service'

export interface EmailMessage {
    to: string
    subject: string
    /** Plain text body. Required so console driver has something to log. */
    text: string
    /** Optional HTML body. */
    html?: string
    /** Free-form tag used by drivers (e.g. Resend tags, log prefix). */
    tag?: string
}

export interface EmailDriver {
    send(message: EmailMessage): Promise<void>
}

class ConsoleEmailDriver implements EmailDriver {
    private readonly logger = new Logger('EmailService')

    async send(message: EmailMessage): Promise<void> {
        const banner = '─'.repeat(60)
        const tag = message.tag ? ` [${message.tag}]` : ''
        this.logger.log(
            `\n${banner}\n[email]${tag} -> ${message.to}\nSubject: ${message.subject}\n${banner}\n${message.text}\n${banner}`
        )
    }
}

const RESEND_API_URL = 'https://api.resend.com/emails'

// Resend only accepts [A-Za-z0-9_-] in tag values; our tags use dots.
const sanitizeResendTag = (tag: string): string =>
    tag.replace(/[^A-Za-z0-9_-]/g, '_')

class ResendEmailDriver implements EmailDriver {
    constructor(
        private readonly config: Extract<
            ResolvedEmailProviderConfig,
            { provider: 'resend' }
        >
    ) {}

    async send(message: EmailMessage): Promise<void> {
        const body: Record<string, unknown> = {
            from: this.config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text
        }
        if (message.html) body.html = message.html
        if (this.config.replyTo) body.reply_to = this.config.replyTo
        if (message.tag)
            body.tags = [{ name: 'tag', value: sanitizeResendTag(message.tag) }]

        const res = await fetch(RESEND_API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000)
        })
        if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 300)
            throw new Error(
                `resend responded ${res.status}${detail ? `: ${detail}` : ''}`
            )
        }
    }
}

// Exported for tests: the option mapping is where an SMTP misconfiguration
// hides (auth omitted for open relays, implicit TLS vs STARTTLS).
export const smtpTransportOptions = (
    config: Extract<ResolvedEmailProviderConfig, { provider: 'smtp' }>
): {
    host: string
    port: number
    secure: boolean
    auth?: { user: string; pass: string }
    connectionTimeout: number
    greetingTimeout: number
    socketTimeout: number
} => ({
    host: config.host,
    port: config.port,
    // secure=true is implicit TLS (typically 465); secure=false starts plain
    // and upgrades via STARTTLS when the server offers it (typically 587).
    secure: config.secure,
    ...(config.username
        ? { auth: { user: config.username, pass: config.password ?? '' } }
        : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000
})

class SmtpEmailDriver implements EmailDriver {
    constructor(
        private readonly config: Extract<
            ResolvedEmailProviderConfig,
            { provider: 'smtp' }
        >
    ) {}

    async send(message: EmailMessage): Promise<void> {
        const transport = createTransport(smtpTransportOptions(this.config))
        try {
            await transport.sendMail({
                from: this.config.from,
                to: message.to,
                subject: message.subject,
                text: message.text,
                ...(message.html ? { html: message.html } : {}),
                ...(this.config.replyTo
                    ? { replyTo: this.config.replyTo }
                    : {})
            })
        } finally {
            transport.close()
        }
    }
}

@Injectable()
export class EmailService implements EmailDriver {
    private readonly logger = new Logger(EmailService.name)
    private readonly consoleDriver = new ConsoleEmailDriver()

    constructor(private readonly settings: EmailSettingsService) {}

    async send(message: EmailMessage): Promise<void> {
        const config = await this.settings.getResolvedConfig()
        const driver =
            config.provider === 'resend'
                ? new ResendEmailDriver(config)
                : config.provider === 'smtp'
                  ? new SmtpEmailDriver(config)
                  : this.consoleDriver
        try {
            await driver.send(message)
        } catch (err) {
            this.logger.error(
                `email.send_failed provider=${config.provider} to=${message.to} subject="${message.subject}"`,
                err
            )
            throw err
        }
    }
}
