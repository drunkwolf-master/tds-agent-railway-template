const MCP_URL    = (process.env.TDS_MCP_URL ?? 'https://tds-mcp-production.up.railway.app').replace(/\/$/, '')
const AUTH_TOKEN = process.env.TDS_AUTH_TOKEN ?? ''

const HEADERS = {
  'Content-Type':  'application/json',
  'Authorization': `Bearer ${AUTH_TOKEN}`,
}

export async function callTool(tool, args = {}) {
  const res = await fetch(`${MCP_URL}/execute`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ tool, args }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MCP tool ${tool} failed (${res.status}): ${err}`)
  }
  return res.json()
}

// Sends a heartbeat to MCP server every 30s so the terminal can detect this agent
export function startHeartbeat(log) {
  const ping = async () => {
    try {
      await fetch(`${MCP_URL}/agent/ping`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ ai_provider: process.env.AI_PROVIDER ?? 'unknown' }),
      })
    } catch {}
  }
  ping() // immediate on startup
  setInterval(ping, 30_000)
  log('heartbeat started')
}
