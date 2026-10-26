// Stands in for uvx in the end-to-end test, which runs it as `uvx <this file> ...`:
// `install-addon` installs, anything else is the (test double) MCP server.
if (process.argv.includes('install-addon')) {
  // The real installer crashes after installing if Python is not told to use UTF-8 for a pipe.
  if (process.env.PYTHONUTF8 !== '1') { console.error('UnicodeEncodeError: the installer was started without PYTHONUTF8=1'); process.exit(1) }
  console.log('Installed MCP for Blender addon to the test profile. In Blender: restart.')
  process.exit(0)
}
await import('./blender-server.mjs')