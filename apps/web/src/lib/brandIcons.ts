/**
 * Deep imports on purpose — do not switch to the `@lobehub/icons` barrel.
 *
 * The package's compound exports (`ClaudeCode.Color`) attach Avatar/Combine
 * subcomponents via property assignment, which bundlers cannot tree-shake,
 * dragging antd-style (CSS-in-JS) + polished into the entry chunk: measured
 * +35 kB gzip on the landing bundle. The bare Color/Mono components are
 * plain SVG. Mono marks render `fill="currentColor"`.
 */
import AnthropicMono from '@lobehub/icons/es/Anthropic/components/Mono'
import ClaudeCodeColor from '@lobehub/icons/es/ClaudeCode/components/Color'
import ClineMono from '@lobehub/icons/es/Cline/components/Mono'
import CodexColor from '@lobehub/icons/es/Codex/components/Color'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import DifyColor from '@lobehub/icons/es/Dify/components/Color'
import GeminiCLIColor from '@lobehub/icons/es/GeminiCLI/components/Color'
import GeminiMono from '@lobehub/icons/es/Gemini/components/Mono'
import GithubMono from '@lobehub/icons/es/Github/components/Mono'
import GithubCopilotMono from '@lobehub/icons/es/GithubCopilot/components/Mono'
import GoogleColor from '@lobehub/icons/es/Google/components/Color'
import GoogleMono from '@lobehub/icons/es/Google/components/Mono'
import HermesAgentMono from '@lobehub/icons/es/HermesAgent/components/Mono'
import MicrosoftColor from '@lobehub/icons/es/Microsoft/components/Color'
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono'
import OpenClawColor from '@lobehub/icons/es/OpenClaw/components/Color'
import WindsurfMono from '@lobehub/icons/es/Windsurf/components/Mono'

export type { IconType } from '@lobehub/icons/es/types'

export {
    AnthropicMono,
    ClaudeCodeColor,
    ClineMono,
    CodexColor,
    CursorMono,
    DifyColor,
    GeminiCLIColor,
    GeminiMono,
    GithubMono,
    GithubCopilotMono,
    GoogleColor,
    GoogleMono,
    HermesAgentMono,
    MicrosoftColor,
    OpenAIMono,
    OpenClawColor,
    WindsurfMono
}
