import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Store } from './store'
import { checkedFetch } from './http'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
interface Account { clientId: string; subject: string; email: string; accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[] }
const random = () => randomBytes(32).toString('base64url')

export class ChatGPTAuth {
  private pending = new Map<string, AbortController>()
  private refreshes = new Map<string, Promise<string>>()
  constructor(private store: Store, private openBrowser: (url: string) => Promise<void>) {}
  account(id: string): Account | undefined {
    const value = this.store.secret(`oauth:${id}`)
    return value ? JSON.parse(value) : undefined
  }
  cancel(id: string) { this.pending.get(id)?.abort(); this.pending.delete(id) }
  async signIn(id: string) {
    if (this.pending.has(id)) throw new Error('A sign-in attempt is already open for this account.')
    const controller = new AbortController()
    this.pending.set(id, controller)
    const previous = this.account(id)
    const state = random(), nonce = random(), verifier = random()
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let redirectUri = ''
    let consumed = false
    let resolveCode!: (value: { code: string; clientId: string }) => void
    let rejectCode!: (error: Error) => void
    const result = new Promise<{ code: string; clientId: string }>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
    // Attach a handler immediately, including when the browser fails to open.
    void result.catch(() => {})
    const server = createServer((request, response) => {
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      response.setHeader('Cache-Control', 'no-store')
      const url = new URL(request.url || '/', redirectUri)
      if (url.pathname !== '/auth/callback' || request.method !== 'GET') { response.writeHead(404).end(); return }
      if (consumed || url.searchParams.get('state') !== state) { response.writeHead(400).end('Sign-in could not be verified.'); return }
      consumed = true
      if (url.searchParams.has('error')) { response.writeHead(400).end('Sign-in was declined. Return to RBX Agents.'); rejectCode(new Error('ChatGPT sign-in was declined.')); return }
      const code = url.searchParams.get('code')
      const clientId = url.searchParams.get('client_id') || previous?.clientId
      if (!code || !clientId || clientId === 'dynamic_agent_client' || (previous && clientId !== previous.clientId)) {
        response.writeHead(400).end('Registration could not be verified.'); rejectCode(new Error('ChatGPT registration was incomplete or the client ID changed.')); return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><title>RBX Agents</title><body style="background:#282a36;color:#f8f8f2;font:18px system-ui;padding:80px"><h1>Return to RBX Agents</h1><p>Your authorization was received. The app is verifying your connection.</p></body></html>')
      resolveCode({ code, clientId })
    })
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000)
    const abort = () => rejectCode(new Error('ChatGPT sign-in was cancelled or timed out.'))
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Could not start the local sign-in callback.')
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const url = new URL(`${ISSUER}/api/accounts/authorize`)
      url.search = new URLSearchParams({ client_id: previous?.clientId || 'dynamic_agent_client', ext_agent_host_id: this.store.state.hostId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge }).toString()
      if (!previous) url.searchParams.set('agent_name_hint', 'RBX Agents')
      if (previous?.idToken) url.searchParams.set('id_token_hint', previous.idToken)
      if (previous?.email) url.searchParams.set('login_hint', previous.email)
      await this.openBrowser(url.toString())
      const callback = await result
      if (!previous) this.store.setSecret(`oauth:${id}`, JSON.stringify({ clientId: callback.clientId, subject: '', email: '', scopes: [], accessToken: '', refreshToken: '', idToken: '', expiresAt: 0 } satisfies Account))
      const tokens = await this.exchange({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, controller.signal)
      if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') throw new Error('ChatGPT did not return the required identity and access tokens.')
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: ISSUER, audience: callback.clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 })
      controller.signal.throwIfAborted()
      if (payload.nonce !== nonce || !payload.sub || (previous?.subject && previous.subject !== payload.sub)) throw new Error('ChatGPT account identity could not be verified.')
      const account: Account = { clientId: callback.clientId, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : 'ChatGPT account', accessToken: tokens.access_token, refreshToken: tokens.refresh_token || '', idToken: tokens.id_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000, scopes: String(tokens.scope || '').split(' ') }
      this.store.setSecret(`oauth:${id}`, JSON.stringify(account))
      const provider = this.store.state.providers.find(p => p.id === id)
      if (!provider) throw new Error('The provider was removed during sign-in.')
      provider.account = account.email
      provider.hasKey = true
      provider.status = account.scopes.includes('chatgpt.tokens.use.direct') ? 'connected' : 'disconnected'
      provider.error = provider.status === 'connected' ? undefined : 'Enable ChatGPT plan usage to make AI requests.'
      this.store.save()
      return provider
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener('abort', abort)
      server.close(); server.closeAllConnections(); this.pending.delete(id)
    }
  }
  private async exchange(body: Record<string, string>, signal?: AbortSignal) {
    const response = await checkedFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal })
    return response.json() as Promise<Record<string, any>>
  }
  async token(id: string): Promise<string> {
    const account = this.account(id)
    if (!account?.accessToken || !account.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('Connect ChatGPT and enable plan usage first.')
    if (account.expiresAt > Date.now() + 60_000) return account.accessToken
    const existing = this.refreshes.get(id)
    if (existing) return existing
    const pending = (async () => {
      if (!account.refreshToken) throw new Error('Your ChatGPT connection expired. Sign in again.')
      const tokens = await this.exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE })
      if (typeof tokens.access_token !== 'string') throw new Error('ChatGPT token refresh did not return an access token.')
      const refreshed: Account = { ...account, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || account.refreshToken, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000, scopes: tokens.scope ? String(tokens.scope).split(' ') : account.scopes }
      this.store.setSecret(`oauth:${id}`, JSON.stringify(refreshed))
      if (!refreshed.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage is no longer enabled. Reconnect the account.')
      return refreshed.accessToken
    })().finally(() => this.refreshes.delete(id))
    this.refreshes.set(id, pending)
    return pending
  }
  async logout(id: string) {
    this.cancel(id)
    // Wait for any rotating-token refresh before revoking the latest token.
    await this.refreshes.get(id)?.catch(() => {})
    const account = this.account(id)
    let revoked = true
    if (account?.refreshToken) {
      try {
        const config = await (await checkedFetch(`${ISSUER}/.well-known/openid-configuration`)).json() as { revocation_endpoint?: string }
        const endpoint = new URL(config.revocation_endpoint || '')
        if (endpoint.origin !== ISSUER || endpoint.protocol !== 'https:') throw new Error('Invalid revocation endpoint')
        await checkedFetch(endpoint.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) })
      } catch { revoked = false }
    }
    if (account) this.store.setSecret(`oauth:${id}`, JSON.stringify({ ...account, accessToken: '', refreshToken: '', idToken: '', scopes: [], expiresAt: 0 }))
    return { revoked }
  }
  close() { for (const controller of this.pending.values()) controller.abort() }
}
