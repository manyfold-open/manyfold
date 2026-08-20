import type { AuthIdentityProvider } from '@manyfold/shared'
import type { FC, SVGProps } from 'react'
import {
    GithubMono,
    GoogleColor,
    GoogleMono,
    MicrosoftColor
} from '@/lib/brandIcons'
import { MailIcon, ProviderIcon } from '@/components/icons'

/* Local brand marks for brands @lobehub/icons doesn't cover. Mono marks
   render with fill='currentColor' so they inherit the surrounding text
   color and adapt to both themes for free — same contract as the
   lobehub Mono components. Multi-color accents (the NetMind clay dot)
   keep their fixed brand hex because they read correctly on both light
   and dark surfaces. */

interface BrandMarkProps extends Omit<
    SVGProps<SVGSVGElement>,
    'width' | 'height'
> {
    size?: number
    // Render fully in currentColor (drops the clay accent dot) — for muted /
    // disconnected contexts where a color accent would read as active.
    mono?: boolean
}

export const NetmindMark: FC<BrandMarkProps> = ({
    size = 16,
    mono,
    ...rest
}) => (
    <svg
        width={size}
        height={size}
        viewBox='0 0 32 32'
        xmlns='http://www.w3.org/2000/svg'
        aria-hidden='true'
        {...rest}
    >
        <path
            d='M22.2599 8.94615C22.5633 8.96582 22.8561 9.06648 23.1088 9.23794C23.3781 9.3773 23.6075 9.58464 23.775 9.84004C24.0495 10.3352 24.1537 10.9091 24.0711 11.471C23.9884 12.033 23.7237 12.5509 23.3187 12.9432C22.9488 13.2607 22.5391 13.5271 22.1002 13.7352C21.4192 14.0609 20.8177 14.5354 20.3386 15.1247C19.6851 15.9164 19.1724 16.8176 18.8235 17.7878C18.5593 18.5045 18.4548 19.2717 18.5177 20.0341C18.5654 20.448 18.5654 20.8661 18.5177 21.28C18.4451 21.8819 18.1536 22.4346 17.7002 22.8297C17.2468 23.2247 16.6643 23.4335 16.067 23.4152C15.4649 23.4371 14.8771 23.2258 14.4229 22.8242C13.9687 22.4225 13.682 21.8605 13.6209 21.2522C13.5732 20.8383 13.5732 20.4202 13.6209 20.0063C13.6815 19.2439 13.5772 18.4772 13.3152 17.76C13.1422 17.2782 12.9268 16.8132 12.6717 16.3706C12.4164 15.9251 12.1248 15.5022 11.8 15.1061C11.4618 14.6938 11.0649 14.3347 10.6226 14.0409C10.4202 13.9232 10.1995 13.8418 9.96999 13.8C9.72812 13.8407 9.49772 13.9339 9.29455 14.0733C8.87081 14.3648 8.48977 14.7156 8.16279 15.1154C7.83797 15.5114 7.5464 15.9344 7.29113 16.3798C7.03779 16.8234 6.82251 17.2883 6.64766 17.7693C6.38485 18.4863 6.28198 19.2535 6.34645 20.0156C6.4064 20.5649 6.36618 21.1207 6.2278 21.6552C6.08649 22.1774 5.77589 22.636 5.34613 22.9571C4.91638 23.278 4.39257 23.4427 3.85927 23.4244C3.55805 23.4117 3.26538 23.3191 3.01043 23.1558C2.74334 23.0126 2.51704 22.802 2.35326 22.5445C2.06804 22.0555 1.95052 21.4843 2.01905 20.9204C2.08758 20.3564 2.33831 19.8314 2.73204 19.4274C3.1273 19.1082 3.55947 18.8391 4.01899 18.6261C4.69967 18.3 5.30114 17.8256 5.78056 17.2367C6.10832 16.8418 6.40151 16.4188 6.65678 15.9722C6.90697 15.5276 7.12066 15.063 7.29569 14.5828C7.5596 13.866 7.66402 13.099 7.60146 12.3365C7.54883 11.9229 7.54883 11.5041 7.60146 11.0906C7.77032 10.2337 8.25406 8.95079 9.97915 8.95079C11.7042 8.95079 12.1606 10.192 12.3614 11.1184C12.4167 11.5318 12.4167 11.9508 12.3614 12.3642C12.2988 13.1267 12.4032 13.8938 12.6671 14.6106C12.8419 15.0916 13.0572 15.5565 13.3106 16C13.5656 16.4478 13.8604 16.8711 14.1913 17.2645C14.5475 17.6986 14.9697 18.0722 15.4418 18.3714C15.6394 18.4922 15.8577 18.5739 16.0853 18.6122C16.3343 18.5662 16.5716 18.4702 16.7835 18.3297C17.2274 18.036 17.6257 17.677 17.9655 17.2645C18.2884 16.8592 18.577 16.4269 18.8281 15.9722C19.0815 15.5287 19.2968 15.0638 19.4715 14.5828C19.7331 13.8655 19.8375 13.0989 19.7773 12.3365C19.7305 11.8736 19.7427 11.4066 19.8138 10.947C19.9781 10.1179 20.941 8.87668 22.2599 8.94615Z'
            fill='currentColor'
            fillRule='evenodd'
            clipRule='evenodd'
        />
        <circle
            cx='27.6908'
            cy='21.085'
            r='2.31'
            fill={mono ? 'currentColor' : '#D97757'}
        />
    </svg>
)

/* Blurple by default: on a marketing surface the mark is doing brand
   recognition, not carrying state, so it reads as "that Discord" at 16px.
   `mono` drops it to currentColor for muted rows. Channel settings render
   Discord through their own provider registry (`channelMeta`) — a bound
   integration and a community invite are different objects. */
export const DiscordMark: FC<BrandMarkProps> = ({
    size = 16,
    mono,
    ...rest
}) => (
    <svg
        width={size}
        height={size}
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
        aria-hidden='true'
        fill={mono ? 'currentColor' : '#5865F2'}
        {...rest}
    >
        <path d='M20.317 4.37a19.79 19.79 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037c-1.687.29-3.33.8-4.885 1.515a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.077.077 0 00.084-.028c.462-.63.874-1.296 1.227-1.995a.076.076 0 00-.015-.088.076.076 0 00-.027-.017 13.107 13.107 0 01-1.872-.893.077.077 0 01-.031-.098.078.078 0 01.023-.03 10.2 10.2 0 00.372-.29.075.075 0 01.077-.011c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.197.373.292a.076.076 0 01.03.065.078.078 0 01-.036.062c-.599.35-1.225.648-1.873.892a.077.077 0 00-.041.106c.36.698.772 1.363 1.225 1.994a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 00-.031-.03zM8.02 15.33c-1.182 0-2.157-1.086-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419s.955-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z' />
    </svg>
)

/* X kept no brand color through the rename — the mark is black on light and
   white on dark — so it is always currentColor and takes no `mono` switch. */
export const XMark: FC<Omit<BrandMarkProps, 'mono'>> = ({
    size = 16,
    ...rest
}) => (
    <svg
        width={size}
        height={size}
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
        aria-hidden='true'
        fill='currentColor'
        {...rest}
    >
        <path d='M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' />
    </svg>
)

/* The single lookup for "show me this sign-in provider's mark." Every
   surface that renders an auth provider (Account settings, login page,
   connect dialogs) goes through this so a brand swap happens in one
   place. Color marks (Google, Microsoft) are theme-independent; mono
   marks (GitHub, NetMind) inherit currentColor. Non-brand providers
   (email, generic SSO) fall back to system icons. */
export const ProviderLogo: FC<{
    provider: AuthIdentityProvider
    size?: number
    className?: string
    // Mono renders every mark in currentColor — for muted / disconnected rows.
    mono?: boolean
}> = ({ provider, size = 16, className, mono }) => {
    switch (provider) {
        case 'google':
            return (
                <span
                    className={['inline-flex shrink-0', className]
                        .filter(Boolean)
                        .join(' ')}
                    aria-hidden='true'
                >
                    {mono ? (
                        <GoogleMono size={size} />
                    ) : (
                        <GoogleColor size={size} />
                    )}
                </span>
            )
        case 'netmind':
            return <NetmindMark size={size} className={className} mono={mono} />
        case 'email':
            return (
                <MailIcon
                    className={className}
                    style={{ width: size, height: size }}
                    aria-hidden='true'
                />
            )
        case 'oidc':
            return (
                <ProviderIcon
                    className={className}
                    style={{ width: size, height: size }}
                    aria-hidden='true'
                />
            )
    }
}

export { GithubMono, GoogleColor, MicrosoftColor }
