import express from 'express'
import { startAgent } from './agent.mjs'

const app = express()
const PORT = process.env.PORT ?? 3000

// Same env var name that mcp-client.mjs uses
const MCP_URL   = (process.env.TDS_MCP_URL ?? 'https://dst-mcp-production.up.railway.app').replace(/\/$/, '')
const AUTH_TOKEN = process.env.TDS_AUTH_TOKEN ?? ''

const logs = []

/** Classify a log message as info / warn / error based on content. */
function classifyLevel(msg) {
  const m = msg.toLowerCase()
  if (m.includes('error') || m.includes('failed') || m.includes('❌') || m.includes('⛔')) return 'error'
  if (m.includes('warn') || m.includes('⚠') || m.includes('skip') || m.includes('insufficient')) return 'warn'
  return 'info'
}

/** Push a single log entry to the MCP server asynchronously (fire-and-forget). */
function pushLog(level, msg) {
  if (!AUTH_TOKEN) return
  fetch(`${MCP_URL}/agent/log`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ level, message: msg }),
  }).catch(() => {}) // never block the agent
}

export function addLog(msg) {
  const entry = { t: new Date().toISOString(), msg }
  logs.unshift(entry)
  if (logs.length > 100) logs.pop()
  console.log(`[agent] ${msg}`)

  const level = classifyLevel(msg)
  pushLog(level, msg)
}

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }))

app.get('/', (_req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>TDS Agent</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { background: #0B0E14; color: #F9FAFB; font-family: 'JetBrains Mono', monospace; padding: 24px; margin: 0; }
    h1 { color: #00FF88; font-size: 16px; letter-spacing: 0.2em; }
    .log { font-size: 12px; color: #9CA3AF; line-height: 1.8; }
    .t { color: #4B5563; margin-right: 8px; }
  </style>
</head>
<body>
  <h1>▶ TDS AGENT</h1>
  <div class="log">${logs.map(l => `<div><span class="t">${l.t}</span>${l.msg}</div>`).join('')}</div>
</body>
</html>`
  res.send(html)
})

app.listen(PORT, async () => {
  addLog(`TDS server running on port ${PORT}`)
  try {
    await startAgent(addLog)
  } catch (err) {
    addLog(`Agent startup error: ${err.message}`)
  }
})
