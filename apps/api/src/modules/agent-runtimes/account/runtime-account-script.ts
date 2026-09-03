import type { ConfigurableFramework } from '@manyfold/shared'

// Vendor endpoints are parameters only so the test can point the emitted
// script at a local HTTP stub; production always passes the defaults.
export interface RuntimeAccountScriptEndpoints {
    anthropicUsage: string
    codexUsage: string
    geminiLoadCodeAssist: string
    geminiUserQuota: string
}

export const RUNTIME_ACCOUNT_ENDPOINTS: RuntimeAccountScriptEndpoints = {
    anthropicUsage: 'https://api.anthropic.com/api/oauth/usage',
    codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
    geminiLoadCodeAssist:
        'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    geminiUserQuota:
        'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
}

// The sandbox half of account.inspect: a hand-mirrored copy of the daemon's
// apps/cli/src/daemon/account-inspect.ts, emitted as a node heredoc because a
// sprite runs no daemon. Same rules — read the CLI's own files, call the
// vendor with the on-disk token, echo the raw response, never print a token —
// and the same nil-mapping stance: the API interprets the vendor body. Its
// sibling test (apps/api/test/runtime-account-script.test.ts) runs the emitted
// script for real; nothing else type checks it.
export const runtimeAccountScript = (
    framework: ConfigurableFramework,
    endpoints: RuntimeAccountScriptEndpoints = RUNTIME_ACCOUNT_ENDPOINTS
): string => {
    const nodeScript = `
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const framework = ${JSON.stringify(framework)}
const endpoints = ${JSON.stringify(endpoints)}
const now = Date.now()
const home = os.homedir()
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const parseAny = (text) => { try { return JSON.parse(text) } catch { return null } }
const parseRecord = (text) => {
  if (!text || !text.trim()) return null
  const parsed = parseAny(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}
const nested = (record, key) => {
  const value = record ? record[key] : null
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
const trimmed = (value) => typeof value === 'string' && value.trim() ? value.trim() : null
const jwtClaims = (value) => {
  if (typeof value !== 'string') return null
  const payload = value.split('.')[1]
  if (!payload) return null
  try {
    return parseRecord(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch { return null }
}
const jwtExpiryMs = (value) => {
  const claims = jwtClaims(value)
  return claims && typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? Math.round(claims.exp * 1000) : null
}
const identityOrNull = (identity) => Object.values(identity).some((field) => field !== null) ? identity : null
const codexHomeDir = () => {
  const raw = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
  return raw ? path.resolve(raw.startsWith('~') ? raw.replace(/^~/, home) : raw) : path.join(home, '.codex')
}
const cliSemver = (bin) => {
  try {
    const out = cp.spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 })
    const match = /\\d+\\.\\d+\\.\\d+/.exec(String(out.stdout || '') + String(out.stderr || ''))
    return match ? match[0] : null
  } catch { return null }
}
const retryAfterSeconds = (header) => {
  if (!header) return null
  const value = header.trim()
  if (/^\\d+$/.test(value)) return Math.min(Number(value), 86400)
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return null
  return Math.min(Math.max(0, Math.ceil((at - now) / 1000)), 86400)
}
const skipped = (vendor) => ({
  vendor, status: 0, body: null, retryAfterSeconds: null,
  error: { kind: 'stale-token', message: null },
  fetchedAt: new Date(now).toISOString()
})
const vendorFetch = async (vendor, url, init) => {
  const fetchedAt = new Date(now).toISOString()
  try {
    const res = await fetch(url, Object.assign({}, init, { redirect: 'error', signal: AbortSignal.timeout(10000) }))
    const text = await res.text()
    const body = res.ok && text.length <= 65536 ? parseAny(text) : null
    return { vendor, status: res.status, body, retryAfterSeconds: retryAfterSeconds(res.headers.get('retry-after')), error: null, fetchedAt }
  } catch (err) {
    const name = err && err.name
    return {
      vendor, status: 0, body: null, retryAfterSeconds: null,
      error: { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', message: (err && err.message) || null },
      fetchedAt
    }
  }
}
const bearer = (token) => ({ Authorization: 'Bearer ' + token, Accept: 'application/json' })
const inspectClaude = async () => {
  const credentials = parseRecord(readText(path.join(home, '.claude', '.credentials.json')))
  const oauth = nested(credentials, 'claudeAiOauth') || nested(credentials, 'oauthAccount')
  const profile = nested(parseRecord(readText(path.join(home, '.claude.json'))), 'oauthAccount')
  const identity = profile ? identityOrNull({
    email: trimmed(profile.emailAddress),
    name: trimmed(profile.displayName) || trimmed(profile.fullName),
    organization: trimmed(profile.organizationName),
    plan: trimmed(oauth && oauth.subscriptionType) || trimmed(profile.organizationType) || trimmed(profile.userRateLimitTier),
    accountId: trimmed(profile.accountUuid)
  }) : null
  const accessToken = trimmed(oauth && oauth.accessToken)
  if (!accessToken) return { tokenSource: process.platform === 'darwin' && profile ? 'keychain-unread' : 'none', identity, usage: null }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return { tokenSource: 'file', identity, usage: skipped('anthropic') }
  const usage = await vendorFetch('anthropic', endpoints.anthropicUsage, {
    headers: Object.assign(bearer(accessToken), {
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/' + (cliSemver('claude') || '2.1.0')
    })
  })
  return { tokenSource: 'file', identity, usage }
}
const inspectCodex = async () => {
  const auth = parseRecord(readText(path.join(codexHomeDir(), 'auth.json')))
  const tokens = nested(auth, 'tokens')
  const claims = jwtClaims(tokens && tokens.id_token)
  const authClaims = nested(claims, 'https://api.openai.com/auth')
  const accountId = trimmed(tokens && tokens.account_id) || trimmed(authClaims && authClaims.chatgpt_account_id)
  const identity = claims ? identityOrNull({
    email: trimmed(claims.email),
    name: trimmed(claims.name),
    organization: null,
    plan: trimmed(authClaims && authClaims.chatgpt_plan_type),
    accountId
  }) : null
  const accessToken = trimmed(tokens && tokens.access_token)
  if ((auth && auth.auth_mode === 'apikey') || !accessToken) return { tokenSource: 'none', identity, usage: null }
  const expiresAt = jwtExpiryMs(accessToken)
  if (expiresAt !== null && expiresAt <= now) return { tokenSource: 'file', identity, usage: skipped('openai') }
  const headers = Object.assign(bearer(accessToken), {
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop'
  })
  if (accountId) headers['ChatGPT-Account-Id'] = accountId
  const usage = await vendorFetch('openai', endpoints.codexUsage, { headers })
  return { tokenSource: 'file', identity, usage }
}
const geminiProjectId = (body) => {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body : null
  const project = record ? record.cloudaicompanionProject : null
  if (typeof project === 'string') return trimmed(project)
  const nestedProject = project && typeof project === 'object' ? project : null
  return trimmed(nestedProject && nestedProject.id) || trimmed(nestedProject && nestedProject.projectId)
}
const inspectGemini = async () => {
  const geminiHome = path.join(home, '.gemini')
  const creds = parseRecord(readText(path.join(geminiHome, 'oauth_creds.json')))
  const accounts = parseRecord(readText(path.join(geminiHome, 'google_accounts.json')))
  const email = trimmed(accounts && accounts.active)
  const identity = email ? { email, name: null, organization: null, plan: null, accountId: null } : null
  const accessToken = trimmed(creds && creds.access_token)
  if (!accessToken) return { tokenSource: process.platform === 'darwin' && identity ? 'keychain-unread' : 'none', identity, usage: null }
  if (typeof creds.expiry_date === 'number' && creds.expiry_date <= now) return { tokenSource: 'file', identity, usage: skipped('google') }
  const headers = Object.assign(bearer(accessToken), { 'Content-Type': 'application/json' })
  const load = await vendorFetch('google', endpoints.geminiLoadCodeAssist, {
    method: 'POST', headers,
    body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } })
  })
  if (load.error || load.status < 200 || load.status >= 300) return { tokenSource: 'file', identity, usage: load }
  const project = geminiProjectId(load.body) || trimmed(process.env.GOOGLE_CLOUD_PROJECT)
  const usage = await vendorFetch('google', endpoints.geminiUserQuota, {
    method: 'POST', headers,
    body: JSON.stringify(project ? { project } : {})
  })
  return { tokenSource: 'file', identity, usage }
}
const main = async () => {
  const report = framework === 'claude-code' ? await inspectClaude() : framework === 'codex' ? await inspectCodex() : await inspectGemini()
  console.log(JSON.stringify({ account: Object.assign({ framework, checkedAt: new Date(now).toISOString() }, report) }))
}
main().catch((err) => {
  console.log(JSON.stringify({ account: { framework, checkedAt: new Date(now).toISOString(), tokenSource: 'none', identity: null, usage: null, error: String(err && err.message || err) } }))
})
`
    return `node <<'MF_ACCOUNT_INSPECT_NODE'\n${nodeScript}\nMF_ACCOUNT_INSPECT_NODE`
}
