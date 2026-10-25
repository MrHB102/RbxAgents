import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { GLOBAL_PROMPT, GLOBAL_PROMPT_V2, LEGACY_AGENT_PROMPTS, LEGACY_GLOBAL_PROMPT, SCHEMA, initialState, migrate } from '../../src/shared/defaults'
import { parseCommand, parseEffort } from '../../src/shared/commands'
import { Store } from '../../src/main/store'
import { resolveModel } from '../../src/main/runtime'

const codec = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }

describe('workspace upgrade', () => {
  it('refreshes untouched default prompts, keeps edited ones, and adds the Master once', () => {
    const state = initialState('host')
    state.schema = 1
    state.agents = state.agents.filter(a => a.id !== 'master')
    state.settings.globalPrompt = LEGACY_GLOBAL_PROMPT
    state.agents.find(a => a.id === 'architect')!.systemPrompt = LEGACY_AGENT_PROMPTS.architect
    state.agents.find(a => a.id === 'builder')!.systemPrompt = 'My own builder prompt'
    migrate(state)
    expect(state.settings.globalPrompt).toBe(GLOBAL_PROMPT)
    expect(state.agents.find(a => a.id === 'architect')!.systemPrompt).not.toBe(LEGACY_AGENT_PROMPTS.architect)
    expect(state.agents.find(a => a.id === 'builder')!.systemPrompt).toBe('My own builder prompt')
    expect(state.agents[0]).toMatchObject({ id: 'master', orchestrator: true })
    expect(state.schema).toBe(SCHEMA)
    state.agents = state.agents.filter(a => a.id !== 'master')
    migrate(state)
    expect(state.agents.some(a => a.id === 'master')).toBe(false)
  })
  it('upgrades the untouched schema 2 workspace prompt to the one with web rules, and keeps edits', () => {
    // Guards the derived text: it must stay byte-identical to what 0.2.0 shipped before web access.
    expect(createHash('sha256').update(GLOBAL_PROMPT_V2).digest('hex')).toBe('e436a9155527c1c60e67746677693e5e5f1275b6d10a9a07b0c5ddd33c7e911b')
    expect(GLOBAL_PROMPT).toContain('web_fetch')
    const state = initialState('host'); state.schema = 2; state.settings.globalPrompt = GLOBAL_PROMPT_V2
    const master = state.agents.find(a => a.id === 'master')!; state.agents = state.agents.filter(a => a.id !== 'master')
    migrate(state)
    expect(state.settings.globalPrompt).toBe(GLOBAL_PROMPT)
    expect(state.agents.some(a => a.id === master.id)).toBe(false)
    const edited = initialState('host'); edited.schema = 2; edited.settings.globalPrompt = `${GLOBAL_PROMPT_V2}\nMy rule.`
    migrate(edited)
    expect(edited.settings.globalPrompt).toBe(`${GLOBAL_PROMPT_V2}\nMy rule.`)
  })
  it('does not overwrite a customized workspace prompt', () => {
    const state = initialState('host'); state.schema = 1; state.settings.globalPrompt = 'Custom rules'
    migrate(state)
    expect(state.settings.globalPrompt).toBe('Custom rules')
  })
  it('upgrades a saved workspace file when the store opens it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rbx-migrate-'))
    try {
      const old = initialState('host'); old.schema = undefined; old.agents = old.agents.filter(a => a.id !== 'master'); old.settings.globalPrompt = LEGACY_GLOBAL_PROMPT
      writeFileSync(join(directory, 'workspace.json'), JSON.stringify(old))
      const store = new Store(directory, codec)
      expect(store.state.agents.some(a => a.orchestrator)).toBe(true)
      expect(store.state.settings.globalPrompt).toBe(GLOBAL_PROMPT)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('slash command parsing', () => {
  it('recognizes only known commands', () => {
    expect(parseCommand('/model gpt-5')).toEqual({ name: 'model', args: 'gpt-5' })
    expect(parseCommand('  /BTW what is this?\nmore')).toEqual({ name: 'btw', args: 'what is this?\nmore' })
    expect(parseCommand('/plan')).toEqual({ name: 'plan', args: '' })
    expect(parseCommand('/Workspace/Map is broken')).toBeNull()
    expect(parseCommand('please /model x')).toBeNull()
  })
  it('parses effort names', () => {
    expect(parseEffort('XHigh')).toBe('xhigh')
    expect(parseEffort('off')).toBe('default')
    expect(parseEffort('turbo')).toBeNull()
  })
})

describe('/model resolution', () => {
  const providers = [
    { id: 'a', name: 'Anthropic', kind: 'anthropic' as const, baseUrl: '', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], status: 'connected' as const, hasKey: true },
    { id: 'o', name: 'Local', kind: 'openai' as const, baseUrl: '', models: ['qwen2.5:7b'], status: 'connected' as const, hasKey: false }
  ]
  it('matches exact, unique partial, and provider-qualified names', () => {
    expect(resolveModel('claude-opus-5-5', providers, 'a')).toMatchObject({ model: 'claude-opus-5-5' })
    expect(resolveModel('haiku', providers, 'a')).toMatchObject({ model: 'claude-haiku-5-5' })
    expect(resolveModel('Local:qwen2.5:7b', providers, 'a')).toMatchObject({ providerId: 'o', model: 'qwen2.5:7b' })
    expect(resolveModel('qwen2.5:7b', providers, 'o')).toMatchObject({ providerId: 'o', model: 'qwen2.5:7b' })
  })
  it('rejects ambiguity and warns about undiscovered names', () => {
    expect(resolveModel('claude', providers, 'a')).toHaveProperty('error')
    expect(resolveModel('brand-new', providers, 'a')).toMatchObject({ model: 'brand-new', note: expect.stringContaining('not in') })
    expect(resolveModel('x', providers, 'missing')).toHaveProperty('error')
  })
})
