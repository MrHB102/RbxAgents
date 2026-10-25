import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initialState, migrate } from '../shared/defaults'
import type { AppState, Activity, RuntimeState } from '../shared/types'

export interface SecretCodec { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export class Store {
  state: AppState
  approvals: RuntimeState['approvals'] = []
  private secrets: Record<string, string> = {}
  private listeners = new Set<() => void>()
  readonly path: string
  constructor(readonly directory: string, private codec: SecretCodec) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'workspace.json')
    this.state = initialState(`urn:uuid:${randomUUID()}`)
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8')) as AppState
        if (saved.version !== 1 || !Array.isArray(saved.agents) || !Array.isArray(saved.sessions) || !Array.isArray(saved.providers) || !saved.settings) throw new Error('Invalid workspace')
        migrate(saved)
        this.state = saved
      } catch {
        copyFileSync(this.path, `${this.path}.recovery-${Date.now()}`)
        this.state.activity.push({ id: randomUUID(), time: new Date().toISOString(), kind: 'error', title: 'Workspace recovered', detail: 'The unreadable workspace was backed up next to workspace.json.' })
      }
    }
    for (const server of this.state.servers) { server.status = 'disconnected'; server.tools = []; delete server.error }
    for (const session of this.state.sessions) if (session.status === 'running' || session.status === 'waiting') {
      session.status = 'idle'
      session.messages.push({ id: randomUUID(), role: 'system', content: 'This run was interrupted when the app closed. Send a message to continue.', createdAt: new Date().toISOString() })
    }
    const vault = join(directory, 'credentials.enc')
    if (existsSync(vault) && codec.available()) {
      try { this.secrets = JSON.parse(codec.decrypt(readFileSync(vault))) }
      catch { this.log('error', 'Credentials unavailable', 'The OS keyring could not unlock saved credentials. Reconnect your providers.') }
    }
    for (const provider of this.state.providers) {
      provider.hasKey = !!this.secret(`provider:${provider.id}`)
      provider.status = 'disconnected'
      delete provider.loginUrl
    }
  }
  get secure() { return this.codec.available() }
  secret(key: string) { return this.secrets[key] || '' }
  setSecret(key: string, value: string) {
    if (value) this.secrets[key] = value
    else delete this.secrets[key]
    if (this.secure) this.atomic(join(this.directory, 'credentials.enc'), this.codec.encrypt(JSON.stringify(this.secrets)))
  }
  private atomic(path: string, value: string | Buffer) {
    const temp = `${path}.tmp`
    writeFileSync(temp, value, { mode: 0o600 })
    renameSync(temp, path)
  }
  save() {
    this.atomic(this.path, JSON.stringify(this.state, null, 2))
    this.emit()
  }
  emit() { for (const listener of this.listeners) listener() }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  log(kind: Activity['kind'], title: string, detail: string, agentId?: string) {
    this.state.activity.unshift({ id: randomUUID(), time: new Date().toISOString(), kind, title, detail: this.redact(detail).slice(0, 4000), agentId })
    this.state.activity = this.state.activity.slice(0, 500)
    this.save()
  }
  redact(text: string): string {
    let result = text
    for (const secret of Object.values(this.secrets)) {
      if (!secret) continue
      result = result.split(secret).join('[redacted]')
      try { const parsed = JSON.parse(secret); for (const value of Object.values(parsed)) if (typeof value === 'string' && value.length > 16) result = result.split(value).join('[redacted]') } catch { /* Plain API key. */ }
    }
    return result
  }
  snapshot(version: string): RuntimeState {
    return structuredClone({ ...this.state, approvals: this.approvals, secureStorage: this.secure, platform: process.platform, appVersion: version, webSearchKey: !!this.secret('web:brave') })
  }
}
