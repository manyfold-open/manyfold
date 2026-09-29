import {
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE,
    parseProbedSemver,
    type AgentFramework,
    type DaemonServiceSpec
} from '@manyfold/shared'
import type {
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import { BootstrapError } from '@/modules/agents/bootstrap/framework-bootstrap'
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
    HERMES_DASHBOARD_PORT,
    HERMES_PORT,
    HERMES_PROXY_PORT,
    HERMES_WEB_BUILD_TIMEOUT_MS,
    hermesConfigYamlFor,
    hermesPaths,
    hermesServiceEnv,
    hermesWebBuildShell
} from '@/modules/agents/bootstrap/hermes-shared'
import { renderHermesFrontProxyScript } from '@/modules/agents/bootstrap/hermes-front-proxy'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import { shellQuote } from '@/modules/agents/workspace/workspace-preflight'
import {
    runHostStep,
    secretFileStep,
    type SessionScriptRunner
} from '@/modules/agents/bootstrap/host-framework-setup'

// The service frameworks a hosted machine runs, a sandbox and a cloud
// computer alike: installed into the host's home through its daemon, and kept
// up by the daemon as its services (ADR-0035 §6) — restarted after a crash,
// and started again after the machine itself restarts.

const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 600_000
const HERMES_INSTALL_TIMEOUT_MS = 900_000
const PROBE_TIMEOUT_MS = 30_000

// The machine a recipe runs on.
export interface ServiceHost {
    // The home its daemon declared.
    home: string
    // It suspends when idle (a sandbox). A framework whose own schedulers
    // would sleep through their clock hands them to Manyfold.
    suspends: boolean
}

export interface ServiceFrameworkSetup {
    spec: DaemonServiceSpec
    // Started after the main service, in this order: the hermes dashboard
    // and the front proxy in front of it.
    companions: DaemonServiceSpec[]
    // The port the host's public entry routes to.
    publicPort: number
    // Minted on the host's behalf (a gateway token, an API server key);
    // stored with the runtime's credentials so the next setup reuses them.
    generatedCredentials: Record<string, string>
}

export interface ServiceInstallRequest extends FrameworkInstallRequest {
    // The repository the version was admitted from (ADR-0022), for a
    // framework whose install clones one.
    frameworkRepo?: string | null
}

export interface ServiceConfigureArgs {
    host: ServiceHost
    runtimeId: string
    credentials: unknown
    envText: string | null
    controlUiEnabled: boolean
    dashboardEnabled: boolean
    // PUBLIC_API_BASE_URL, for a framework that calls back into Manyfold.
    apiBaseUrl: string | null
}

export interface ServiceFrameworkRecipe {
    readonly framework: AgentFramework
    readonly serviceName: string
    // Every companion the recipe can run: one a setup leaves out is removed.
    readonly companionNames: readonly string[]
    readonly port: number
    home(hostHome: string): string
    // Where the runtime and a new agent's workspace are on a sandbox.
    readonly sandbox: {
        mountPath(hostHome: string): string
        // When the framework owns its workspace layout (runner.lazyWorkspace)
        // this is only a seed: nothing may address a file through it before
        // the files provider resolves it.
        workspaceSeed(hostHome: string, agentId: string, userId: string): string
    }
    install(
        runner: SessionScriptRunner,
        request: ServiceInstallRequest & { host: ServiceHost }
    ): Promise<string | null>
    // Writes the framework's config for these settings and returns its
    // services. Rerun on a credential, env, control UI or dashboard change.
    configure(
        runner: SessionScriptRunner,
        args: ServiceConfigureArgs
    ): Promise<ServiceFrameworkSetup>
}

const openclawRecipe: ServiceFrameworkRecipe = {
    framework: 'openclaw',
    serviceName: 'openclaw',
    companionNames: [],
    port: OPENCLAW_PORT,
    home: (hostHome) => `${hostHome}/.openclaw`,
    sandbox: {
        mountPath: (hostHome) => openclawDefaultWorkspace(`${hostHome}/.openclaw`),
        workspaceSeed: (hostHome) => openclawDefaultWorkspace(`${hostHome}/.openclaw`)
    },
    // The staged npm install every npm framework gets, then the Chromium
    // build OpenClaw drives for browser tasks.
    install: async (runner, request) => {
        const version = await installFrameworkVersionOn(
            runner,
            request,
            'openclaw'
        )
        await runHostStep(
            runner,
            'openclaw-browser',
            'npx --yes playwright install chromium',
            { timeoutMs: PLAYWRIGHT_INSTALL_TIMEOUT_MS }
        )
        return version
    },
    configure: async (runner, args) => {
        const home = openclawRecipe.home(args.host.home)
        const creds = args.credentials as ResolvedOpenclawCredentials
        const gatewayToken = generateOpenclawGatewayToken(creds.gatewayToken)
        // The config holds the provider key and the gateway token.
        const config = secretFileStep(
            shellQuote(`${home}/openclaw.json`),
            'MF_OPENCLAW_CONFIG_B64',
            openclawConfigJsonFor({
                creds,
                gatewayToken,
                home,
                controlUiEnabled: args.controlUiEnabled
            })
        )
        await runHostStep(
            runner,
            'openclaw-config',
            [
                `mkdir -p ${shellQuote(openclawDefaultWorkspace(home))}`,
                config.script
            ].join('\n'),
            { env: config.env }
        )
        return {
            spec: {
                name: 'openclaw',
                command: ['openclaw', 'gateway'],
                dir: home,
                env: openclawServiceEnv({
                    creds,
                    gatewayToken,
                    home,
                    controlUiEnabled: args.controlUiEnabled,
                    envText: args.envText
                }),
                port: OPENCLAW_PORT,
                healthPath: '/healthz'
            },
            companions: [],
            publicPort: OPENCLAW_PORT,
            generatedCredentials: { gatewayToken }
        }
    }
}

const hermesRecipe: ServiceFrameworkRecipe = {
    framework: 'hermes',
    serviceName: 'hermes',
    companionNames: [HERMES_DASHBOARD_SERVICE, HERMES_PROXY_SERVICE],
    port: HERMES_PORT,
    home: (hostHome) => `${hostHome}/.hermes`,
    sandbox: {
        mountPath: (hostHome) => `${hostHome}/.hermes`,
        workspaceSeed: (hostHome) => `${hostHome}/.hermes`
    },
    // NousResearch's installer, pinned to the resolved tag; what landed is
    // read back from the checkout.
    install: async (runner, request) => {
        await runHostStep(
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
        const paths = hermesPaths(hermesRecipe.home(args.host.home))
        const creds = args.credentials as ResolvedHermesCredentials
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        // config.yaml is what `hermes acp` and the gateway read for the model
        // and provider; it carries the provider key.
        const config = secretFileStep(
            shellQuote(`${paths.home}/config.yaml`),
            'MF_HERMES_CONFIG_B64',
            hermesConfigYamlFor(creds)
        )
        await runHostStep(runner, 'hermes-config', config.script, {
            env: config.env
        })
        const env = hermesServiceEnv({
            creds,
            apiServerKey,
            envText: args.envText
        })
        const spec: DaemonServiceSpec = {
            name: 'hermes',
            command: [paths.bin, 'gateway'],
            dir: paths.home,
            env,
            port: HERMES_PORT,
            healthPath: '/v1/health'
        }
        const generatedCredentials = { apiServerKey }
        if (!args.dashboardEnabled)
            return {
                spec,
                companions: [],
                publicPort: HERMES_PORT,
                generatedCredentials
            }
        return {
            spec,
            companions: await hermesDashboard(runner, paths, creds, env),
            publicPort: HERMES_PROXY_PORT,
            generatedCredentials
        }
    }
}

// hermes's own web UI behind a front proxy that takes over the public port:
// /v1 goes to the gateway, the UI's assets and API to `hermes dashboard`, and
// its HTML only to a tokened visit, since hermes injects its session token
// into index.html for any caller in loopback mode (hermes-front-proxy.ts).
const hermesDashboard = async (
    runner: SessionScriptRunner,
    paths: ReturnType<typeof hermesPaths>,
    creds: ResolvedHermesCredentials,
    gatewayEnv: Record<string, string>
): Promise<DaemonServiceSpec[]> => {
    if (!creds.dashboardToken)
        throw new BootstrapError(
            'hermes-dashboard',
            'credentials missing dashboardToken — persist it before enabling'
        )
    await runHostStep(
        runner,
        'hermes-dashboard-build',
        hermesWebBuildShell(paths.home),
        { timeoutMs: HERMES_WEB_BUILD_TIMEOUT_MS }
    )
    const proxyScript = `${paths.home}/mf-front-proxy.mjs`
    const proxy = secretFileStep(
        shellQuote(proxyScript),
        'MF_HERMES_PROXY_B64',
        renderHermesFrontProxyScript()
    )
    await runHostStep(runner, 'hermes-dashboard-proxy', proxy.script, {
        env: proxy.env
    })
    return [
        {
            name: HERMES_DASHBOARD_SERVICE,
            command: [
                paths.bin,
                'dashboard',
                '--no-open',
                '--skip-build',
                '--host',
                '127.0.0.1',
                '--port',
                String(HERMES_DASHBOARD_PORT)
            ],
            dir: paths.home,
            env: {
                ...gatewayEnv,
                // Only the gateway runs the API server; the web server must
                // never race it for the port.
                API_SERVER_ENABLED: 'false',
                HERMES_DASHBOARD_SESSION_TOKEN: creds.dashboardToken,
                HERMES_WEB_DIST: paths.webDistDir
            },
            port: HERMES_DASHBOARD_PORT,
            // Any answer below 500 counts: it serves its page to loopback.
            healthPath: '/'
        },
        {
            name: HERMES_PROXY_SERVICE,
            command: ['node', proxyScript],
            dir: paths.home,
            env: {
                MF_PROXY_PORT: String(HERMES_PROXY_PORT),
                MF_GATEWAY_PORT: String(HERMES_PORT),
                MF_DASHBOARD_PORT: String(HERMES_DASHBOARD_PORT),
                MF_DASHBOARD_TOKEN: creds.dashboardToken
            },
            port: HERMES_PROXY_PORT,
            // Answered through the proxy by the gateway: both are up.
            healthPath: '/v1/health'
        }
    ]
}

const CORE_RECIPES: ReadonlyMap<string, ServiceFrameworkRecipe> = new Map(
    [openclawRecipe, hermesRecipe].map((recipe) => [recipe.framework, recipe])
)
const extensionRecipes = new Map<string, ServiceFrameworkRecipe>()

// An edition's service framework brings its recipe with its framework
// extension (ADR-0034), which registers it here.
export const registerServiceFrameworkRecipe = (
    recipe: ServiceFrameworkRecipe
): void => {
    if (
        CORE_RECIPES.has(recipe.framework) ||
        extensionRecipes.has(recipe.framework)
    )
        throw new Error(
            `framework '${recipe.framework}' already has a service recipe`
        )
    extensionRecipes.set(recipe.framework, recipe)
}

export const serviceFrameworkRecipe = (
    framework: AgentFramework
): ServiceFrameworkRecipe | undefined =>
    CORE_RECIPES.get(framework) ?? extensionRecipes.get(framework)
