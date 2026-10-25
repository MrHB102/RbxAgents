import { expect, it } from 'vitest'
import { realWeb, webGet } from '../../src/main/web'

// Uses the real internet. RBX_LIVE_WEB=1 npx vitest run tests/unit/web.live
const live = process.env.RBX_LIVE_WEB === '1'
const signal = () => new AbortController().signal

it.skipIf(!live)('searches and reads real pages', async () => {
  const found = await realWeb.search('Roblox RunService Heartbeat documentation', 5, signal())
  expect(found.results.length).toBeGreaterThan(0)
  expect(found.results.every(r => /^https?:\/\//.test(r.url) && r.title)).toBe(true)
  const page = await realWeb.fetch('https://en.wikipedia.org/wiki/Roblox', signal())
  expect(page.title).toMatch(/Roblox/)
  expect(page.text.length).toBeGreaterThan(1000)
  expect(page.text).not.toMatch(/<script|<div/)
}, 60_000)

it.skipIf(!live)('refuses a public name that points at this machine (DNS check at connection time)', async () => {
  await expect(webGet('http://localtest.me/')).rejects.toThrow(/private or internal/)
}, 30_000)
