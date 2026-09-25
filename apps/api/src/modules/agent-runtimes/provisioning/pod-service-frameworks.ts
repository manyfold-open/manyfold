import {
    K8S_HOME_BASE,
    parseProbedSemver,
    type AgentFramework,
    type DaemonServiceSpec
} from '@manyfold/shared'
import type {
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import {
    installFrameworkVersionOn,
    type FrameworkInstallRequest
} from '@/modules/agents/bootstrap/framework-version-install'
import {
    generateOpenclawGatewayToken,
    OPENCLAW_PORT,
    openclawConfigJsonFor,
    openclawDefaultWorkspace,
    openclawServiceEnv
} from '@/modules/agents/bootstrap/openclaw-shared'
import {
    buildHermesInstallScript,
    generateHermesApiServerKey,
    HERMES_PORT,
    hermesConfigYamlFor,
    hermesPaths,
    hermesServiceEnv
} from '@/modules/agents/bootstrap/hermes-shared'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import { shellQuote } from '@/modules/agents/workspace/workspace-preflight'
import { runPodStep, type PodScriptRunner } from './pod-framework-setup'

// The service frameworks a pod host runs (ADR-0035 P2): installed into the
// home volume with the recipes a sprite uses, and kept up by the host's
// daemon as services instead of the sprite's Services API.

const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 600_000
const HERMES_INSTALL_TIMEOUT_MS = 900_000
const PROBE_TIMEOUT_MS = 30_000

export interface PodServiceSetup {
    spec: DaemonServiceSpec
    // Minted on the host's behalf (a gateway token, an API server key);
    // stored with the runtime's credentials so the next setup reuses them.
    generatedCredentials: Record<string, string>
}

export interface PodInstallRequest extends FrameworkInstallRequest {
    // The repository the version was admitted from (ADR-0022), for a
    // framework whose install clones one.
    frameworkRepo?: string | null
}

export interface PodServiceRecipe {
    readonly framework: AgentFramework
    readonly serviceName: string
    readonly home: string
    readonly port: number
    install(
        runner: PodScriptRunner,
        request: PodInstallRequest
    ): Promise<string | null>
    // Writes the framework's config for these credentials and returns its
    // service. Rerun on a credential or env change.
    configure(
        runner: PodScriptRunner,
        args: {
            credentials: unknown
            envText: string | null
            controlUiEnabled: boolean
        }
    ): Promise<PodServiceSetup>
}

// A secret-bearing file, written atomically and readable by its owner only;
// base64 so no content can end the script early.
const writeFileScript = (path: string, content: string): string =>
    [
        'set -eu',
        `mkdir -p "$(dirname ${shellQuote(path)})"`,
        'umask 077',
        `printf '%s' ${shellQuote(Buffer.from(content, 'utf8').toString('base64'))} | base64 -d > ${shellQuote(`${path}.tmp`)}`,
        `mv -f ${shellQuote(`${path}.tmp`)} ${shellQuote(path)}`
    ].join('\n')

const OPENCLAW_HOME = `${K8S_HOME_BASE}/.openclaw`

const openclawRecipe: PodServiceRecipe = {
    framework: 'openclaw',
    serviceName: 'openclaw',
    home: OPENCLAW_HOME,
    port: OPENCLAW_PORT,
    // The staged npm install every npm framework gets, then the Chromium
    // build OpenClaw drives for browser tasks (its system libraries are in
    // the host image).
    install: async (runner, request) => {
        const version = await installFrameworkVersionOn(
            runner,
            request,
            'openclaw'
        )
        await runPodStep(
            runner,
            'openclaw-browser',
            'npx --yes playwright install chromium',
            { timeoutMs: PLAYWRIGHT_INSTALL_TIMEOUT_MS }
        )
        return version
    },
    configure: async (runner, args) => {
        const creds = args.credentials as ResolvedOpenclawCredentials
        const gatewayToken = generateOpenclawGatewayToken(creds.gatewayToken)
        await runPodStep(
            runner,
            'openclaw-config',
            [
                `mkdir -p ${shellQuote(openclawDefaultWorkspace(OPENCLAW_HOME))}`,
                writeFileScript(
                    `${OPENCLAW_HOME}/openclaw.json`,
                    openclawConfigJsonFor({
                        creds,
                        gatewayToken,
                        home: OPENCLAW_HOME,
                        controlUiEnabled: args.controlUiEnabled
                    })
                )
            ].join('\n')
        )
        return {
            spec: {
                name: 'openclaw',
                command: ['openclaw', 'gateway'],
                dir: OPENCLAW_HOME,
                env: openclawServiceEnv({
                    creds,
                    gatewayToken,
                    home: OPENCLAW_HOME,
                    controlUiEnabled: args.controlUiEnabled,
                    envText: args.envText
                }),
                port: OPENCLAW_PORT,
                healthPath: '/healthz'
            },
            generatedCredentials: { gatewayToken }
        }
    }
}

const HERMES = hermesPaths(`${K8S_HOME_BASE}/.hermes`)

const hermesRecipe: PodServiceRecipe = {
    framework: 'hermes',
    serviceName: 'hermes',
    home: HERMES.home,
    port: HERMES_PORT,
    // NousResearch's installer, pinned to the resolved tag as on a sprite;
    // what landed is read back from the checkout.
    install: async (runner, request) => {
        await runPodStep(
            runner,
            'hermes-install',
            buildHermesInstallScript(request.frameworkVersion ?? null),
            { timeoutMs: HERMES_INSTALL_TIMEOUT_MS }
        )
        const probe = await runner.run(
            frameworkVersionDescriptor('hermes').probeShell,
            PROBE_TIMEOUT_MS
        )
        return parseProbedSemver(`${probe.stdout}\n${probe.stderr}`)
    },
    configure: async (runner, args) => {
        const creds = args.credentials as ResolvedHermesCredentials
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        await runPodStep(
            runner,
            'hermes-config',
            writeFileScript(`${HERMES.home}/config.yaml`, hermesConfigYamlFor(creds))
        )
        return {
            spec: {
                name: 'hermes',
                command: [HERMES.bin, 'gateway'],
                dir: HERMES.home,
                env: hermesServiceEnv({
                    creds,
                    apiServerKey,
                    envText: args.envText
                }),
                port: HERMES_PORT,
                healthPath: '/v1/health'
            },
            generatedCredentials: { apiServerKey }
        }
    }
}

const CORE_RECIPES: ReadonlyMap<string, PodServiceRecipe> = new Map(
    [openclawRecipe, hermesRecipe].map((recipe) => [recipe.framework, recipe])
)
const extensionRecipes = new Map<string, PodServiceRecipe>()

// An edition's service framework brings its recipe with its framework
// extension (ADR-0034), which registers it here.
export const registerPodServiceRecipe = (recipe: PodServiceRecipe): void => {
    if (
        CORE_RECIPES.has(recipe.framework) ||
        extensionRecipes.has(recipe.framework)
    )
        throw new Error(
            `framework '${recipe.framework}' already has a pod service recipe`
        )
    extensionRecipes.set(recipe.framework, recipe)
}

export const podServiceRecipe = (
    framework: AgentFramework
): PodServiceRecipe | undefined =>
    CORE_RECIPES.get(framework) ?? extensionRecipes.get(framework)
