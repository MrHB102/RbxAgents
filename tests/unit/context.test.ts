import { describe, expect, it } from 'vitest'
import { boundedText, compactTurns, findTools, skillPage, toolResultText } from '../../src/main/context'
import type { Turn } from '../../src/main/providers'
import { initialState } from '../../src/shared/defaults'

describe('economy context', () => {
  it('keeps the latest user request while removing old conversation exchanges', () => {
    const turns: Turn[] = [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'old '.repeat(20_000) }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'Current task' }]
    const result = compactTurns(turns)
    expect(result[0]).toEqual(turns[0])
    expect(result.at(-1)).toEqual(turns[3])
    expect(result[1].content).toContain('Earlier task excerpt')
    expect(JSON.stringify(result).length).toBeLessThan(36_000)
    expect(turns).toHaveLength(4)
  })
  it('removes complete old tool rounds without leaving orphan tool results', () => {
    const turns: Turn[] = [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Current task' }, { role: 'assistant', content: '', tool_calls: [{ id: 'old', type: 'function', function: { name: 'call_tool', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'old', content: 'old output '.repeat(8000) }, { role: 'assistant', content: '', tool_calls: [{ id: 'recent', type: 'function', function: { name: 'call_tool', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'recent', content: 'Current result' }]
    const result = compactTurns(turns)
    expect(result.some(t => t.tool_call_id === 'old')).toBe(false)
    expect(result.some(t => t.tool_call_id === 'recent')).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThan(36_000)
  })
  it('does not shorten the current task or silently drop oversized instructions', () => {
    expect(() => compactTurns([{ role: 'system', content: 'x'.repeat(40_000) }, { role: 'user', content: 'Current task' }])).toThrow('Shorten')
    expect(boundedText('x'.repeat(120_000)).length).toBeLessThanOrEqual(6000)
  })
  it('finds tools on demand and filters writes from read-only discovery', () => {
    const servers = initialState('host').servers
    servers[0].tools = [{ name: 'execute_luau', description: 'Run code', inputSchema: {}, readOnly: false }, { name: 'get_connected_instances', description: 'List Studio instances', inputSchema: {}, readOnly: true }]
    expect(findTools(servers, 'execute_luau', false)[0].name).toBe('execute_luau')
    expect(findTools(servers, 'execute_luau', true)).toEqual([])
    expect(findTools(servers, 'instances', true)[0].server_id).toBe('roblox')
  })
  it('pages heavily escaped references without corrupting JSON or exceeding the result limit', () => {
    const text = '\\"\n'.repeat(10_000)
    const output = skillPage(text, 'test', 'references/full.md', 0, 5000)
    const page = JSON.parse(output)
    expect(output.length).toBeLessThanOrEqual(6000)
    expect(page.content).toBe(text.slice(0, page.nextOffset))
    expect(page.nextOffset).toBeGreaterThan(0)
    expect(toolResultText({ content: [{ type: 'image', data: 'binary'.repeat(50_000) }] }).length).toBeLessThan(200)
  })
})
