import { describe, expect, it } from 'vitest'
import { BLENDER_ID, SCHEMA, blenderAgent, blenderServer, defaultAgents, initialState, migrate } from '../../src/shared/defaults'

describe('the Blender connection in a workspace', () => {
  it('comes with a Blender connection and an Artist agent wired to it', () => {
    const state = initialState('host')
    expect(state.schema).toBe(SCHEMA)
    expect(state.servers.map(s => s.id)).toEqual(['roblox', BLENDER_ID])
    const artist = state.agents.find(a => a.id === 'artist')!
    expect(artist.mcpIds).toEqual([BLENDER_ID])
    expect(artist.permission).toBe('ask')
    expect(artist.systemPrompt).toContain('render_preview')
    expect(defaultAgents().filter(a => a.mcpIds.includes(BLENDER_ID))).toHaveLength(1)
  })
  it('adds both to an older workspace once, without touching anything the user changed', () => {
    const state = initialState('host')
    state.schema = 4
    state.servers = state.servers.filter(s => s.id !== BLENDER_ID)
    state.agents = state.agents.filter(a => a.id !== 'artist')
    state.agents.find(a => a.id === 'builder')!.systemPrompt = 'My own prompt.'
    migrate(state)
    expect(state.schema).toBe(SCHEMA)
    expect(state.servers.filter(s => s.id === BLENDER_ID)).toHaveLength(1)
    expect(state.agents.filter(a => a.id === 'artist')).toHaveLength(1)
    expect(state.agents.find(a => a.id === 'builder')!.systemPrompt).toBe('My own prompt.')
    state.schema = 4
    migrate(state)
    expect(state.servers.filter(s => s.id === BLENDER_ID)).toHaveLength(1)
    expect(state.agents.filter(a => a.id === 'artist')).toHaveLength(1)
  })
  it('keeps a Blender connection or Artist the user already customized', () => {
    const state = initialState('host')
    state.schema = 4
    state.servers.find(s => s.id === BLENDER_ID)!.args = ['mcp-for-blender@9.9.9', '--port', '9999']
    const artist = state.agents.find(a => a.id === 'artist')!
    artist.name = 'My modeler'; artist.permission = 'unrestricted'
    migrate(state)
    expect(state.servers.find(s => s.id === BLENDER_ID)!.args).toEqual(['mcp-for-blender@9.9.9', '--port', '9999'])
    expect(state.agents.find(a => a.id === 'artist')).toMatchObject({ name: 'My modeler', permission: 'unrestricted' })
  })
  it('gives each new workspace its own copy', () => {
    expect(blenderServer()).not.toBe(blenderServer())
    expect(blenderAgent().mcpIds).not.toBe(blenderAgent().mcpIds)
  })
})