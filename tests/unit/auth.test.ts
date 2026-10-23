import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../../src/main/store'
import { ChatGPTAuth } from '../../src/main/auth'
import { checkedFetch } from '../../src/main/http'
import { jwtVerify } from 'jose'

vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(() => ({})), jwtVerify: vi.fn() }))
vi.mock('../../src/main/http', async original => ({ ...await original<typeof import('../../src/main/http')>(), checkedFetch: vi.fn() }))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-auth-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  store.state.providers.push({ id: 'account', name: 'ChatGPT', kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1', models: [], hasKey: false, status: 'disconnected' })
  return { store, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}
beforeEach(() => vi.clearAllMocks())
describe('ChatGPT authorization', () => {
  it('validates state, sends PKCE, verifies identity, and retains the issued registration', async () => {
    const { store, cleanup } = fixture()
    let authorization!: URL
    const auth = new ChatGPTAuth(store, async value => {
      authorization = new URL(value)
      const invalid = new URL(authorization.searchParams.get('redirect_uri')!)
      invalid.search = new URLSearchParams({ state: 'incorrect-state', code: 'untrusted-code', client_id: 'oaiapp_test' }).toString()
      expect((await fetch(invalid)).status).toBe(400)
      const valid = new URL(authorization.searchParams.get('redirect_uri')!)
      valid.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'valid-code', client_id: 'oaiapp_test' }).toString()
      expect((await fetch(valid)).status).toBe(200)
    })
    vi.mocked(checkedFetch).mockImplementation(async (_url, init) => {
      const body = init!.body as URLSearchParams
      expect(body.get('client_id')).toBe('oaiapp_test')
      expect(body.get('code')).toBe('valid-code')
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
      expect(body.has('client_secret')).toBe(false)
      expect(body.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
      return new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', id_token: 'signed-id-token', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }))
    })
    vi.mocked(jwtVerify).mockImplementation(async () => ({ payload: { sub: 'verified-user', email: 'builder@example.com', nonce: authorization.searchParams.get('nonce') }, protectedHeader: { alg: 'RS256' } }) as any)
    try {
      await auth.signIn('account')
      expect(authorization.searchParams.get('agent_name_hint')).toBe('RBX Agents')
      expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
      expect(authorization.searchParams.get('ext_agent_host_id')).toBe(store.state.hostId)
      expect(jwtVerify).toHaveBeenCalledWith('signed-id-token', expect.anything(), expect.objectContaining({ issuer: 'https://auth.openai.com', audience: 'oaiapp_test' }))
      expect(auth.account('account')?.subject).toBe('verified-user')
      expect(store.state.providers[0].status).toBe('connected')
      expect(JSON.stringify(store.snapshot('test'))).not.toContain('test-access')
    } finally { auth.close(); cleanup() }
  })
  it('rejects an identity nonce mismatch without replacing the account', async () => {
    const { store, cleanup } = fixture()
    const auth = new ChatGPTAuth(store, async value => {
      const authorization = new URL(value)
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'valid-code', client_id: 'oaiapp_test' }).toString()
      await fetch(callback)
    })
    vi.mocked(checkedFetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'must-not-save', id_token: 'invalid-nonce-token', scope: 'chatgpt.tokens.use.direct' })))
    vi.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'user', nonce: 'incorrect-nonce' }, protectedHeader: { alg: 'RS256' } } as any)
    try {
      await expect(auth.signIn('account')).rejects.toThrow('identity')
      expect(auth.account('account')?.accessToken).toBe('')
      expect(store.state.providers[0].status).toBe('disconnected')
    } finally { auth.close(); cleanup() }
  })
  it('serializes concurrent refreshes and stores the rotated refresh token', async () => {
    const { store, cleanup } = fixture()
    const auth = new ChatGPTAuth(store, async () => {})
    store.setSecret('oauth:account', JSON.stringify({ clientId: 'oaiapp_test', subject: 'user', email: 'builder@example.com', accessToken: 'expired', refreshToken: 'old-refresh', idToken: '', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 0 }))
    vi.mocked(checkedFetch).mockImplementation(async () => new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 3600 })))
    try {
      expect(await Promise.all([auth.token('account'), auth.token('account'), auth.token('account')])).toEqual(['fresh-access', 'fresh-access', 'fresh-access'])
      expect(checkedFetch).toHaveBeenCalledOnce()
      expect(auth.account('account')?.refreshToken).toBe('rotated-refresh')
    } finally { cleanup() }
  })
  it('does not save a connection cancelled during identity verification', async () => {
    const { store, cleanup } = fixture()
    let nonce = ''
    let finishIdentity!: (value: any) => void
    const identity = new Promise<any>(resolve => { finishIdentity = resolve })
    const auth = new ChatGPTAuth(store, async value => {
      const authorization = new URL(value)
      nonce = authorization.searchParams.get('nonce')!
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'valid-code', client_id: 'oaiapp_test' }).toString()
      await fetch(callback)
    })
    vi.mocked(checkedFetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'cancelled-access', id_token: 'signed-token', scope: 'chatgpt.tokens.use.direct' })))
    vi.mocked(jwtVerify).mockImplementation(() => identity)
    try {
      const pending = auth.signIn('account')
      const rejected = expect(pending).rejects.toThrow()
      await vi.waitFor(() => expect(jwtVerify).toHaveBeenCalled())
      auth.cancel('account')
      finishIdentity({ payload: { sub: 'verified-user', nonce }, protectedHeader: { alg: 'RS256' } })
      await rejected
      expect(auth.account('account')?.accessToken).toBe('')
      expect(store.state.providers[0].status).toBe('disconnected')
    } finally { auth.close(); cleanup() }
  })
})
