import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'

// A daemon platform turn must not rewrite the user's native Gemini settings.
// Keep the original system policy, reject conflicting policy, and layer only
// this turn's non-secret settings in a private, short-lived system file.
export const geminiPlatformLauncher = (
    gatewayTargets: readonly string[]
): string => String.raw`
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const targets = ${JSON.stringify(gatewayTargets)}
let directory = null
let child = null
let requestedSignal = null
let cancellation = null
let cancelInput = null
const ownerDirectory = process.env.MF_EXEC_TEMP_DIR
const signalOwned = (signal) => {
    if (!child?.pid || child.pid === process.pid) return
    if (ownerDirectory) {
        child.kill(signal)
        return
    }
    try { process.kill(-child.pid, signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
}
const forward = (signal) => {
    requestedSignal = signal
    cancelInput?.()
    if (!child) return
    signalOwned(signal)
    cancellation ||= new Promise((resolve) => setTimeout(() => {
        signalOwned('SIGKILL')
        resolve()
    }, 1000))
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => forward(signal))
async function main() {
    if (process.platform === 'win32' && !ownerDirectory)
        throw new Error('Gemini platform settings require a resource-owning Manyfold CLI')
    const original = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (
        process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' :
        process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json'
    )
    let settings = {}
    try { settings = JSON.parse(fs.readFileSync(original, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read Gemini system settings') }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Gemini system settings')
    const section = (object, key) => {
        const value = object[key]
        if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid Gemini system policy section')
        return object[key] ||= {}
    }
    const auth = section(section(settings, 'security'), 'auth')
    if ((auth.enforcedType && auth.enforcedType !== 'gemini-api-key') ||
        (auth.selectedType && auth.selectedType !== 'gemini-api-key') || auth.useExternal === true)
        throw new Error('Gemini system authentication policy does not allow platform credentials')
    auth.selectedType = 'gemini-api-key'
    const model = (process.env.GEMINI_MODEL || '').trim()
    const baseUrl = (process.env.GOOGLE_GEMINI_BASE_URL || '').trim().replace(/\/+$/, '')
    if (settings.model?.name && model && settings.model.name !== model)
        throw new Error('Gemini system model policy conflicts with the platform model')
    if (baseUrl && baseUrl !== ${JSON.stringify(OFFICIAL_PROVIDER_BASE_URL.google)} && model) {
        if ((settings.modelConfigs && Object.keys(settings.modelConfigs).length) || settings.experimental?.dynamicModelConfiguration === false)
            throw new Error('Gemini system model policy conflicts with platform gateway routing')
        section(settings, 'experimental').dynamicModelConfiguration = true
        settings.modelConfigs = {
            modelIdResolutions: { [model]: { default: model, contexts: [] } },
            customOverrides: targets.map((target) => ({ match: { model: target }, modelConfig: { model } }))
        }
    }
    directory = fs.mkdtempSync(path.join(ownerDirectory || os.tmpdir(), 'mf-gemini-platform-'))
    fs.chmodSync(directory, 0o700)
    const file = path.join(directory, 'settings.json')
    fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 })
    const prompt = await new Promise((resolve, reject) => {
        let text = ''
        cancelInput = () => {
            resolve(null)
            process.stdin.pause()
            process.stdin.unref?.()
            process.stdin.destroy()
        }
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (chunk) => { text += chunk })
        process.stdin.once('end', () => resolve(text))
        process.stdin.once('error', reject)
        process.stdin.resume()
        if (requestedSignal) cancelInput()
    })
    cancelInput = null
    if (requestedSignal) return 128 + ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[requestedSignal])
    child = spawn('bash', ['-c', 'exec gemini "$@"', 'gemini', '--prompt', prompt, ...process.argv.slice(1)], {
        detached: !ownerDirectory && process.platform !== 'win32',
        stdio: 'inherit', env: { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: file }
    })
    const result = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve(code ?? 128 + ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9 }[signal] || 1)))
    })
    if (cancellation) await cancellation
    return requestedSignal ? 128 + ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[requestedSignal]) : result
}
main().then((code) => { process.exitCode = code }, (error) => {
    console.error(error.message)
    process.exitCode = 1
}).finally(() => {
    if (directory) {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
`
