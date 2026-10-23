import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type SecretCodec } from '../../src/main/store'

const unavailable: SecretCodec = { available: () => false, encrypt: () => { throw new Error('Unavailable') }, decrypt: () => { throw new Error('Unavailable') } }
describe('workspace and credential storage', () => {
  it('keeps credentials in memory when an OS keyring is unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rbx-store-'))
    try {
      const store = new Store(directory, unavailable)
      store.setSecret('provider:test', 'private-test-secret-value')
      store.log('info', 'Test', 'Never show private-test-secret-value')
      expect(store.secret('provider:test')).toBe('private-test-secret-value')
      expect(existsSync(join(directory, 'credentials.enc'))).toBe(false)
      expect(readFileSync(store.path, 'utf8')).not.toContain('private-test-secret-value')
      expect(store.state.activity[0].detail).toContain('[redacted]')
      expect(new Store(directory, unavailable).secret('provider:test')).toBe('')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('persists agent changes and marks interrupted sessions as idle on restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rbx-store-'))
    try {
      const store = new Store(directory, unavailable)
      store.state.agents[0].name = 'Custom architect'
      store.state.sessions.push({ id: 'session', agentId: 'architect', title: 'Task', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tokens: 0, status: 'running' })
      store.save()
      const restored = new Store(directory, unavailable)
      expect(restored.state.agents[0].name).toBe('Custom architect')
      expect(restored.state.sessions[0].status).toBe('idle')
      expect(restored.state.sessions[0].messages[0].content).toContain('interrupted')
      expect(restored.state.hostId).toBe(store.state.hostId)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
