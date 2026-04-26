/**
 * TDS Agent — Production-Grade Trading Engine v2.0
 *
 * Architecture:
 *   - Reads strategy.md via SSE stream (real-time updates)
 *   - Parses @Skill directives and runs each skill on its own schedule
 *   - All trades go through callTool('execute_swap') → Uniswap V3 on Base
 *   - State is held in-memory (survives strategy updates, not agent restarts)
 *
 * Supported tokens on-chain: USDC, USDT (→USDC), WETH/ETH
 * Market data for signals: ETH, BTC, SOL, ARB, OP, LINK, UNI, AAVE, and 30+ more
 *
 * Amount conventions (critical for correctness):
 *   BUY  (USDC → WETH): amount_in  = USDC amount  e.g. "100"
 *   SELL (WETH → USDC): amount_out = USDC to receive e.g. "100"  [exactOutput]
 *   SELL by position %: amount_in  = WETH amount  e.g. "0.03"   [exactInput]
 */

import { callTool, startHeartbeat } from './mcp-client.mjs'

// ── ACP (Virtuals Agent Commerce Protocol) buyer mode ─────────────────────
// When ACP is enabled, trades route through Virtuals ACP jobs instead of
// direct MCP calls. Fee is paid via ACP escrow, not the 0.1% treasury fee.
let ACP_ENABLED = false
let ACP_API_KEY = ''
let ACP_WALLET = ''  // Virtuals agent wallet address (receives USDC for ACP fees)
const ACP_API_BASE = process.env.ACP_API_URL ?? 'https://claw-api.virtuals.io'
const TDS_SELLER_ADDRESS = process.env.TDS_SELLER_ADDRESS ?? ''
const ACP_AUTO_FUND_AMOUNT = '0.1'  // USDC to auto-transfer (covers ~10 ACP jobs)
const ACP_MIN_BALANCE = 0.02        // USDC threshold to trigger auto-fund

// USDC contract address — Base mainnet (ACP is mainnet-only)
const USDC_ADDRESS_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RPC_URL = process.env.RPC_URL ?? 'https://mainnet.base.org'

/**
 * Check USDC balance of any address via direct JSON-RPC call.
 * Uses ERC20 balanceOf(address) — selector 0x70a08231.
 */
async function getUsdcBalance(address) {
  const paddedAddr = address.toLowerCase().replace('0x', '').padStart(64, '0')
  const data = `0x70a08231${paddedAddr}` // balanceOf(address)
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: USDC_ADDRESS_MAINNET, data }, 'latest'],
    }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  const raw = BigInt(json.result ?? '0x0')
  return Number(raw) / 1e6 // USDC has 6 decimals
}

/**
 * Auto-fund the Virtuals wallet with USDC from the TDS wallet.
 * Called before each ACP job to ensure the Virtuals wallet has enough USDC
 * to cover the ACP escrow fee ($0.01 per job).
 */
async function ensureAcpFunding() {
  if (!ACP_WALLET) {
    console.log('[ACP] No ACP wallet address configured — skipping auto-fund')
    return
  }

  try {
    const usdcBalance = await getUsdcBalance(ACP_WALLET)
    console.log(`[ACP] Virtuals wallet USDC balance: $${usdcBalance.toFixed(4)}`)

    if (usdcBalance >= ACP_MIN_BALANCE) return // sufficient funds

    // Auto-fund: withdraw USDC from TDS wallet to Virtuals wallet
    console.log(`[ACP] Auto-funding Virtuals wallet with $${ACP_AUTO_FUND_AMOUNT} USDC`)
    const fundRes = await fetch(`${TDS_MCP_URL}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TDS_AUTH_TOKEN}` },
      body: JSON.stringify({ toAddress: ACP_WALLET, amount: ACP_AUTO_FUND_AMOUNT, asset: 'USDC' }),
    })
    const fundData = await fundRes.json()
    if (!fundRes.ok) throw new Error(fundData?.error ?? `HTTP ${fundRes.status}`)
    console.log(`[ACP] ✓ Auto-fund complete: tx=${fundData?.txHash ?? 'unknown'}`)
  } catch (e) {
    console.error(`[ACP] Auto-fund failed: ${e.message} — proceeding anyway (job may fail)`)
  }
}

async function callToolViaACP(params) {
  if (!ACP_API_KEY) throw new Error('ACP API key not configured')
  if (!TDS_SELLER_ADDRESS) throw new Error('TDS_SELLER_ADDRESS not configured')

  // Ensure Virtuals wallet has enough USDC for ACP fee
  await ensureAcpFunding()

  // Create ACP job
  const jobRes = await fetch(`${ACP_API_BASE}/acp/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ACP_API_KEY },
    body: JSON.stringify({
      providerWalletAddress: TDS_SELLER_ADDRESS,
      jobOfferingName: 'spot_swap',
      serviceRequirements: params,
    }),
  })
  const jobData = await jobRes.json()
  const jobId = jobData?.data?.jobId ?? jobData?.jobId
  if (!jobId) throw new Error(`ACP job creation failed: ${JSON.stringify(jobData)}`)

  console.log(`[ACP] Job created: ${jobId}`)

  // Poll until complete (max 5 min)
  const maxPolls = 60
  const pollInterval = 5000
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollInterval))

    const statusRes = await fetch(`${ACP_API_BASE}/acp/jobs/${jobId}`, {
      headers: { 'x-api-key': ACP_API_KEY },
    })
    const statusData = await statusRes.json()
    const job = Array.isArray(statusData) ? statusData[0] : statusData

    // Check memoHistory for actual phase (top-level phase can be stale)
    const latestPhase = job?.memoHistory?.length > 0
      ? job.memoHistory.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).at(-1)?.nextPhase ?? 'PENDING'
      : job?.status ?? job?.phase ?? 'PENDING'

    if (latestPhase === 'COMPLETED' || latestPhase === 'completed') {
      console.log(`[ACP] Job ${jobId} completed`)
      return job.deliverable ?? {}
    }
    if (latestPhase === 'FAILED' || latestPhase === 'failed' || latestPhase === 'REJECTED') {
      throw new Error(`ACP job ${jobId} failed`)
    }
    if (latestPhase === 'TRANSACTION' || latestPhase === 'transaction') {
      // Auto-approve payment (check if not already approved)
      const pending = job?.memoHistory?.filter(m => m.nextPhase === 'TRANSACTION' && m.status === 'PENDING')?.length ?? 0
      if (pending > 0) {
        console.log(`[ACP] Auto-approving payment for job ${jobId}`)
        await fetch(`${ACP_API_BASE}/acp/jobs/${jobId}/pay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ACP_API_KEY },
          body: JSON.stringify({ accept: true, content: 'Approved' }),
        }).catch(() => {})
      }
    }
  }
  throw new Error(`ACP job ${jobId} timed out after ${maxPolls * pollInterval / 1000}s`)
}

// ── Serial transaction queue ───────────────────────────────────────────────
// Prevents nonce collisions when multiple skills fire simultaneously.
// All execute_swap calls are serialized through this promise chain.
let _txQueue = Promise.resolve()
function queueSwap(params) {
  const result = _txQueue.then(async () => {
    const r = ACP_ENABLED ? await callToolViaACP(params) : await callTool('execute_swap', params)
    if (r?.router) console.log(`[swap] routed via ${r.router}`)
    if (r?.execLogs?.length) r.execLogs.forEach(l => console.log(`[swap] ${l}`))
    return r
  })
  _txQueue = result.catch(() => {})
  return result
}

const TDS_AUTH_TOKEN = process.env.TDS_AUTH_TOKEN ?? ''
const TDS_MCP_URL    = (process.env.TDS_MCP_URL ?? 'https://dst-mcp-production.up.railway.app').replace(/\/$/, '')

// Dynamic token sets — loaded from /tokens/config at startup.
let SWAPPABLE_SYMBOLS = []  // all swappable token symbols
let TOKEN_CONFIG = []       // full config: [{ symbol, is_stablecoin, decimals }]

function isStable(sym) {
  const cfg = TOKEN_CONFIG.find(t => t.symbol === (sym ?? '').toUpperCase())
  return cfg?.is_stablecoin === true
}

async function loadTokenConfig() {
  try {
    const res = await fetch(`${TDS_MCP_URL}/tokens/config`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    TOKEN_CONFIG = data.tokens ?? []
    SWAPPABLE_SYMBOLS = TOKEN_CONFIG.map(t => t.symbol)
    // Also add WETH since it's filtered from /tokens but is valid for swaps
    if (!SWAPPABLE_SYMBOLS.includes('WETH')) SWAPPABLE_SYMBOLS.push('WETH')
    return data
  } catch (e) {
    console.warn(`[tokenConfig] Failed to load: ${e.message} — using defaults`)
    return null
  }
}

// Fetch AI config from MCP server — set by user in the terminal setup page.
// Falls back to env vars so manual Railway variable overrides still work.
async function loadAgentConfig() {
  // Env var overrides take priority
  if (process.env.AI_API_KEY || process.env.VERTEX_PROJECT_ID) {
    return {
      AI_API_KEY:        process.env.AI_API_KEY           ?? '',
      VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID    ?? '',
      VERTEX_SA_JSON:    process.env.VERTEX_SERVICE_ACCOUNT_JSON ?? '',
      AI_PROVIDER:       process.env.AI_PROVIDER          ?? 'openai',
      ACP_API_KEY:       process.env.ACP_API_KEY          ?? '',
      ACP_ENABLED:       process.env.ACP_ENABLED === 'true',
      ACP_WALLET:        process.env.ACP_WALLET           ?? '',
    }
  }
  // Fetch from MCP server
  try {
    const res = await fetch(`${TDS_MCP_URL}/user/agent-config`, {
      headers: { Authorization: `Bearer ${TDS_AUTH_TOKEN}` },
    })
    if (res.ok) {
      const cfg = await res.json()
      return {
        AI_API_KEY:        cfg.apiKey            ?? '',
        VERTEX_PROJECT_ID: cfg.vertexProjectId   ?? '',
        VERTEX_SA_JSON:    cfg.vertexSaJson       ?? '',
        AI_PROVIDER:       cfg.provider           ?? 'openai',
        ACP_API_KEY:       cfg.acpApiKey          ?? '',
        ACP_ENABLED:       cfg.acpEnabled         ?? false,
        ACP_WALLET:        cfg.acpWallet          ?? '',
      }
    }
  } catch {}
  return { AI_API_KEY: '', VERTEX_PROJECT_ID: '', VERTEX_SA_JSON: '', AI_PROVIDER: 'openai', ACP_API_KEY: '', ACP_ENABLED: false, ACP_WALLET: '' }
}

// Config loaded at startup — see startAgent() below
let AI_API_KEY        = ''
let VERTEX_PROJECT_ID = ''
let VERTEX_SA_JSON    = ''
let AI_PROVIDER       = 'openai'
const VERTEX_REGION   = process.env.VERTEX_REGION ?? 'global'

// ── Vertex AI access token ─────────────────────────────────────────────────
let _vertexToken     = null
let _vertexTokenExp  = 0

async function getVertexAccessToken() {
  if (_vertexToken && Date.now() < _vertexTokenExp - 60_000) return _vertexToken

  if (!VERTEX_SA_JSON) throw new Error('VERTEX_SERVICE_ACCOUNT_JSON is not set')
  const sa = JSON.parse(VERTEX_SA_JSON)

  // Build JWT for Google OAuth2 service-account flow
  const now   = Math.floor(Date.now() / 1000)
  const claim = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }

  // Base64url helpers (no external deps)
  const b64url = s => Buffer.from(s).toString('base64url')
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claim))
  const sigInput = `${header}.${payload}`

  // Sign with private key using Node crypto
  const { createSign } = await import('node:crypto')
  const signer = createSign('RSA-SHA256')
  signer.update(sigInput)
  const sig = signer.sign(sa.private_key, 'base64url')
  const jwt = `${sigInput}.${sig}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  })
  const d = await res.json()
  if (!d.access_token) throw new Error(`Vertex token error: ${JSON.stringify(d)}`)
  _vertexToken    = d.access_token
  _vertexTokenExp = Date.now() + (d.expires_in ?? 3600) * 1000
  return _vertexToken
}

// ── Config ─────────────────────────────────────────────────────────────────
const MAX_RETRIES          = 3      // consecutive failures before pausing skill
const GAS_BUFFER_ETH       = 0.001  // always keep ≥ 0.001 ETH for gas
const MAX_POSITION_PCT     = 0.90   // never use more than 90% of balance

// SWAPPABLE_TOKENS is now derived from SWAPPABLE_SYMBOLS (loaded dynamically)
const SWAPPABLE_TOKENS = { has: (sym) => SWAPPABLE_SYMBOLS.includes(sym) }

// ── Utility ────────────────────────────────────────────────────────────────

function parseIntervalMs(s) {
  if (!s) return null
  const str = String(s).trim().toLowerCase()
  const units = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }
  // Support compound durations like "7h50m", "1h30m15s"
  const parts = [...str.matchAll(/([\d.]+)\s*(s|m|h|d|w)(?:ec|in|r|ay|eek)?/g)]
  if (!parts.length) return null
  let total = 0
  for (const p of parts) total += parseFloat(p[1]) * (units[p[2]] ?? 36e5)
  return total
}

function parseDollar(s) {
  return parseFloat(String(s ?? '').replace(/[$,\s]/g, '')) || null
}

function parsePct(s) {
  return parseFloat(String(s ?? '').replace(/%/g, '')) || null
}

/** Extract key:value pairs from a @Skill block */
function parseBlock(text) {
  const params = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s*([\w_]+)\s*:\s*(.+)$/)
    if (m) params[m[1].trim()] = m[2].trim()
  }
  return params
}

// ── In-memory skill state ──────────────────────────────────────────────────

const STATE = {}  // keyed by skill+token

function getState(key)     { return STATE[key] ?? {} }
function setState(key, obj){ STATE[key] = { ...STATE[key], ...obj } }
function clearState(key)   { delete STATE[key] }

// ── Active timers (cleared on strategy reload) ────────────────────────────

let activeTimers = []

// Per-task in-flight guard — prevents swap queue buildup when blockchain confirmation
// takes longer than the task interval. If a task is still running, skip the next tick.
const _taskInFlight = new Set()

// ── Safety Helpers ─────────────────────────────────────────────────────────

/**
 * Pre-trade balance check.
 * Returns { ok, eth, usdc, ethUsd, totalUsd, ethPrice, tokens }
 * Caller should abort if !ok.
 */
async function checkBalance(log, context = '') {
  try {
    const p = await callTool('get_portfolio')
    const eth      = parseFloat(p.eth  ?? 0)
    const usdc     = parseFloat(p.usdc ?? 0)
    const ethPrice = parseFloat(p.eth_price ?? 0)
    const totalUsd = parseFloat(p.total_usd ?? 0)
    const tokens   = p.tokens ?? []
    if (eth < GAS_BUFFER_ETH) {
      log(`[${context}] ⚠ ETH balance ${eth.toFixed(4)} below gas buffer ${GAS_BUFFER_ETH} — skipping`)
      return { ok: false, eth, usdc, ethUsd: eth * ethPrice, totalUsd, ethPrice, tokens }
    }
    return { ok: true, eth, usdc, ethUsd: eth * ethPrice, totalUsd, ethPrice, tokens }
  } catch (e) {
    log(`[${context}] balance check failed: ${e.message}`)
    return { ok: false, eth: 0, usdc: 0, ethUsd: 0, totalUsd: 0, ethPrice: 0, tokens: [] }
  }
}

function getTokenBalance(bal, sym) {
  if (sym === 'ETH' || sym === 'WETH') return bal.eth
  const entry = bal.tokens?.find(t => t.symbol === sym)
  return parseFloat(entry?.amount ?? '0')
}

/**
 * Cap a trade amount to MAX_POSITION_PCT of available balance.
 * Returns the safe amount (string) or null if insufficient.
 */
function safeAmount(requestedAmt, available, tokenSym, context, log) {
  if (available <= 0) {
    log(`[${context}] no ${tokenSym} available, skip`)
    return null
  }
  const max = available * MAX_POSITION_PCT
  if (requestedAmt > max) {
    log(`[${context}] requested ${requestedAmt} > available ${max.toFixed(4)} ${tokenSym} — capping to ${max.toFixed(4)}`)
  }
  return Math.min(requestedAmt, max).toFixed(6)
}

/**
 * Wrap a skill run function with retry and failure-pause logic.
 * Returns a setInterval timer ID.
 */
const CIRCUIT_RESET_MS = 30 * 60_000 // auto-reset paused skill after 30 minutes

function scheduleSkill(skillName, intervalMs, checkFn, log) {
  const key = `${skillName}_failures`

  async function tick() {
    const s = getState(key)
    const failures = s.failures ?? 0
    if (failures >= MAX_RETRIES) {
      // Auto-reset after CIRCUIT_RESET_MS so transient infra issues don't pause forever
      const pausedAt = s.pausedAt ?? Date.now()
      if (!s.pausedAt) setState(key, { pausedAt })
      if (Date.now() - pausedAt >= CIRCUIT_RESET_MS) {
        log(`[${skillName}] 🔄 auto-reset after 30m pause — retrying`)
        setState(key, { failures: 0, pauseLogged: false, pausedAt: null })
      } else {
        if (!s.pauseLogged) {
          log(`[${skillName}] ⛔ paused after ${MAX_RETRIES} failures — auto-retries in 30m or update strategy`)
          setState(key, { pauseLogged: true, pausedAt })
        }
        return
      }
    }
    try {
      await checkFn()
      setState(key, { failures: 0, pausedAt: null })
    } catch (e) {
      const next = (getState(key).failures ?? 0) + 1
      setState(key, { failures: next, pauseLogged: false })
      log(`[${skillName}] ❌ error (${next}/${MAX_RETRIES}): ${e.message}`)
    }
  }

  tick() // run immediately on strategy load
  return setInterval(tick, intervalMs)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @DCA — Dollar Cost Averaging
// ═══════════════════════════════════════════════════════════════════════════

// interval shorthand: 30m, 1h, 6h, 24h, 1w — or spelled out hour/min/day/week
const INTERVAL_RE = /([\d.]+)\s*(s(?:ec)?|m(?:in)?|h(?:r|our)?|d(?:ay)?|w(?:eek)?)s?/i

function parseDCA(text) {
  // Optional "worth of" / "of" between amount and token (e.g. "$1 worth of ETH")
  const WORTH = '(?:worth\\s+(?:of\\s+)?|of\\s+)?'

  // Format 1: "@DCA buy $X TOKEN_IN -> TOKEN_OUT every INTERVAL"
  const mArrow = text.match(new RegExp(`@DCA\\s+buy\\s+\\$?([\\d.]+)\\s+${WORTH}(\\w+)\\s*[-→>]+\\s*(\\w+)\\s+every\\s+`, 'i'))
  if (mArrow) {
    const [, amount, tokenIn, tokenOut] = mArrow
    const iv = text.match(/every\s+(.+)/i)?.[1]
    return { amount: parseDollar(amount), tokenIn: tokenIn.toUpperCase(),
             tokenOut: tokenOut.toUpperCase(), exactOutput: false,
             intervalMs: parseIntervalMs(iv) ?? 6 * 36e5 }
  }
  // Format 2: "@DCA buy $X TOKEN_OUT with/from TOKEN_IN every INTERVAL"
  // exactOutput when TOKEN_OUT is pegged to $1 (receive exact dollar amount)
  const mWith = text.match(new RegExp(`@DCA\\s+buy\\s+\\$?([\\d.]+)\\s+${WORTH}(\\w+)\\s+(?:with|from|using)\\s+(\\w+)\\s+every\\s+`, 'i'))
  if (mWith) {
    const [, amount, tokenOut, tokenIn] = mWith
    const tOut = tokenOut.toUpperCase()
    const iv   = text.match(/every\s+(.+)/i)?.[1]
    return { amount: parseDollar(amount), tokenIn: tokenIn.toUpperCase(),
             tokenOut: tOut, exactOutput: isStable(tOut),
             intervalMs: parseIntervalMs(iv) ?? 6 * 36e5 }
  }
  // Format 3: "@DCA buy $X TOKEN every INTERVAL [from SOURCE]" — single token
  const mSingle = text.match(new RegExp(`@DCA\\s+buy\\s+\\$?([\\d.]+)\\s+${WORTH}(\\w+)\\s+every\\s+`, 'i'))
  if (mSingle) {
    const [, amount, token] = mSingle
    const tok = token.toUpperCase()
    const iv  = text.match(/every\s+(.+?)(?:\s+from\s|\s+using\s|$)/i)?.[1]
    const fromMatch = text.match(/(?:from|using)\s+(\w+)/i)
    if (!fromMatch) return null
    const tokenIn  = fromMatch[1].toUpperCase()
    return { amount: parseDollar(amount), tokenIn, tokenOut: tok, exactOutput: false,
             intervalMs: parseIntervalMs(iv) ?? 6 * 36e5 }
  }
  // Block format
  const p = parseBlock(text)
  if (!p.token_in || !p.token_out) return null
  return {
    amount:      parseDollar(p.amount) ?? 50,
    tokenIn:     p.token_in.toUpperCase(),
    tokenOut:    p.token_out.toUpperCase(),
    exactOutput: false,
    intervalMs:  parseIntervalMs(p.interval) ?? 4 * 36e5,
  }
}

async function runDCA(params, log) {
  const { amount, tokenIn, tokenOut, exactOutput, intervalMs } = params
  const desc = exactOutput
    ? `get ${amount} ${tokenOut} with ${tokenIn}`
    : `spend ${amount} ${tokenIn} → ${tokenOut}`
  log(`[DCA] ${desc} every ${(intervalMs / 36e5).toFixed(1)}h`)

  return scheduleSkill('DCA', intervalMs, async () => {
    const bal = await checkBalance(log, 'DCA')
    if (!bal.ok) return

    if (exactOutput) {
      log(`[DCA] exactOutput: receive ${amount} ${tokenOut}`)
      const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_out: String(amount) })
      log(`[DCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    } else if (isStable(tokenIn)) {
      const tokenBal = getTokenBalance(bal, tokenIn)
      const safeAmt = safeAmount(amount, tokenBal, tokenIn, 'DCA', log)
      if (!safeAmt) return
      log(`[DCA] buying ${safeAmt} ${tokenIn} → ${tokenOut}`)
      const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_in: safeAmt })
      log(`[DCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    } else {
      const tokenBal = getTokenBalance(bal, tokenIn)
      const price = await callTool('get_price', { token: tokenIn === 'WETH' ? 'ETH' : tokenIn }).then(d => d?.price_usd ?? 0).catch(() => 0)
      const tokenAmt = price > 0 ? Math.min(amount / price, tokenBal * MAX_POSITION_PCT) : 0
      if (tokenAmt < 0.000001) { log(`[DCA] insufficient ${tokenIn}`); return }
      log(`[DCA] selling ${tokenAmt.toFixed(6)} ${tokenIn} → ${tokenOut}`)
      const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_in: tokenAmt.toFixed(6) })
      log(`[DCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @ValueAvg — Value Averaging
// ═══════════════════════════════════════════════════════════════════════════

function parseValueAvg(text) {
  const p = parseBlock(text)
  return {
    targetMonthly: parseDollar(p.target_monthly_increase) ?? 200,
    intervalMs:    parseIntervalMs(p.interval) ?? 7 * 864e5,
    maxBuy:        parseDollar(p.max_buy) ?? 500,
  }
}

async function runValueAvg(params, log) {
  const { targetMonthly, intervalMs, maxBuy } = params
  // Unique key per instance (supports multiple ValueAvg blocks with different params)
  const stateKey = `valueavg_${targetMonthly}_${intervalMs}`
  // Periods per month based on interval
  const periodsPerMonth = (30 * 864e5) / intervalMs
  const perPeriod       = targetMonthly / periodsPerMonth
  log(`[ValueAvg] target +$${targetMonthly}/mo → ~$${perPeriod.toFixed(2)}/period`)

  return scheduleSkill('ValueAvg', intervalMs, async () => {
    const bal = await checkBalance(log, 'ValueAvg')
    if (!bal.ok) return

    const s = getState(stateKey)
    if (!s.startValue) {
      setState(stateKey, { startValue: bal.ethUsd, startTime: Date.now(), period: 0 })
    }

    const periodsSince = Math.ceil((Date.now() - (getState(stateKey).startTime ?? Date.now())) / intervalMs)
    const targetNow    = (getState(stateKey).startValue ?? bal.ethUsd) + periodsSince * perPeriod
    const gap          = targetNow - bal.ethUsd

    log(`[ValueAvg] ETH portfolio $${bal.ethUsd.toFixed(2)} target $${targetNow.toFixed(2)} gap $${gap.toFixed(2)}`)

    if (gap <= 0) { log(`[ValueAvg] portfolio on target, skip`); return }

    const buyUsd  = Math.min(gap, maxBuy)
    const safeAmt = safeAmount(buyUsd, bal.usdc, 'USDC', 'ValueAvg', log)
    if (!safeAmt) return

    log(`[ValueAvg] buying $${safeAmt} USDC → WETH`)
    const r = await queueSwap({ token_in: 'USDC', token_out: 'WETH', amount_in: safeAmt })
    log(`[ValueAvg] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    setState(stateKey, { period: periodsSince })
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @MomentumDCA — Momentum-Filtered DCA
// ═══════════════════════════════════════════════════════════════════════════

function parseMomentumDCA(text) {
  const p = parseBlock(text)
  const tokenOut = (p.token_out ?? p.token ?? '').toUpperCase()
  const tokenIn  = (p.token_in ?? '').toUpperCase()
  if (!tokenIn || !tokenOut) return null
  const signalToken = isStable(tokenOut) ? tokenIn : tokenOut
  return {
    tokenIn, tokenOut, signalToken,
    amount:     parseDollar(p.amount) ?? 50,
    intervalMs: parseIntervalMs(p.interval) ?? 6 * 36e5,
    minDrop:    parsePct(p.min_drop ?? p.min_rise) ?? 2,
    emaPeriod:  parseInt(p.ema_period ?? '20', 10),
    selling:    isStable(tokenOut),
  }
}

async function runMomentumDCA(params, log) {
  const { tokenIn, tokenOut, signalToken, amount, intervalMs, minDrop, emaPeriod, selling } = params
  const direction = selling
    ? `sell ${signalToken}→USDC when ${signalToken} ≥${minDrop}% ABOVE EMA${emaPeriod}`
    : `buy ${tokenOut} when ${signalToken} ≥${minDrop}% BELOW EMA${emaPeriod}`
  log(`[MomentumDCA] ${direction}`)

  return scheduleSkill('MomentumDCA', intervalMs, async () => {
    const bal = await checkBalance(log, 'MomentumDCA')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token: signalToken })
    const EMA_MAP = { 9: 'ema_9', 12: 'ema_12', 20: 'ema_20', 26: 'ema_26', 50: 'ema_50' }
    const emaField = EMA_MAP[emaPeriod] ?? (emaPeriod <= 10 ? 'ema_9' : emaPeriod <= 18 ? 'ema_12' : emaPeriod <= 23 ? 'ema_20' : emaPeriod <= 38 ? 'ema_26' : 'ema_50')
    const ema  = ind[emaField] ?? ind.ema_20 ?? ind.price_usd
    if (!ema || ema <= 0 || !ind.price_usd) {
      log(`[MomentumDCA] ⚠ invalid indicator data (ema=${ema}, price=${ind.price_usd}) — skipping`)
      return
    }
    // pctAbove > 0 means price is above EMA (rally); < 0 means below EMA (dip)
    const pctAbove = ((ind.price_usd - ema) / ema) * 100
    const pctBelow = -pctAbove

    const status = pctAbove >= 0
      ? `${pctAbove.toFixed(2)}% ABOVE EMA`
      : `${pctBelow.toFixed(2)}% BELOW EMA`
    log(`[MomentumDCA] ${signalToken} $${ind.price_usd?.toFixed(2)} EMA${emaPeriod}=$${ema?.toFixed(2)} — ${status}`)

    if (selling) {
      if (pctAbove >= minDrop) {
        const tokenBal = getTokenBalance(bal, tokenIn)
        const maxToSpend = tokenBal * MAX_POSITION_PCT
        if (maxToSpend <= 0) { log(`[MomentumDCA] insufficient ${tokenIn} to sell`); return }
        log(`[MomentumDCA] ✅ rally signal: ${pctAbove.toFixed(2)}% above EMA — selling ${tokenIn} → ${tokenOut}`)
        const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_out: String(amount) })
        log(`[MomentumDCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      } else {
        log(`[MomentumDCA] waiting — need ${minDrop}% rally above EMA, currently ${pctAbove >= 0 ? pctAbove.toFixed(2) + '% above' : pctBelow.toFixed(2) + '% below'}`)
      }
    } else {
      if (pctBelow >= minDrop) {
        const tokenBal = getTokenBalance(bal, tokenIn)
        const safeAmt = safeAmount(amount, tokenBal, tokenIn, 'MomentumDCA', log)
        if (!safeAmt) return
        log(`[MomentumDCA] ✅ dip signal: ${pctBelow.toFixed(2)}% below EMA — buying $${safeAmt} ${tokenIn} → ${tokenOut}`)
        const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_in: safeAmt })
        log(`[MomentumDCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      } else {
        log(`[MomentumDCA] waiting — need ${minDrop}% dip below EMA, currently ${pctBelow >= 0 ? pctBelow.toFixed(2) + '% below' : pctAbove.toFixed(2) + '% above'}`)
      }
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @Grid — Grid Trading
// ═══════════════════════════════════════════════════════════════════════════

function parseGrid(text) {
  const p = parseBlock(text)
  return {
    token:         (p.token ?? 'WETH').toUpperCase(),
    lower:         parseDollar(p.lower)          ?? 2000,
    upper:         parseDollar(p.upper)          ?? 4000,
    grids:         parseInt(p.grids ?? '10', 10),
    amountPerGrid: parseDollar(p.amount_per_grid) ?? 50,
    intervalMs:    parseIntervalMs(p.check_interval) ?? 15 * 6e4,
  }
}

async function runGrid(params, log) {
  const { token, lower, upper, grids, amountPerGrid, intervalMs } = params
  const gridSize = (upper - lower) / grids
  const key      = `grid_${token}`
  log(`[Grid] ${token} $${lower}–$${upper} × ${grids} grids ($${gridSize.toFixed(0)}/grid) $${amountPerGrid}/trade`)

  return scheduleSkill(`Grid_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'Grid')
    if (!bal.ok) return

    const price = await callTool('get_price', { token })
    const p     = price.price_usd ?? 0

    if (p < lower || p > upper) {
      log(`[Grid] ${token} $${p.toFixed(2)} outside range [$${lower}–$${upper}] — paused`)
      return
    }

    const level    = Math.floor((p - lower) / gridSize)
    const s        = getState(key)
    const prevLvl  = s.lastLevel ?? level  // initialise on first run

    log(`[Grid] ${token} $${p.toFixed(2)} level=${level} prev=${prevLvl}`)

    if (level < prevLvl) {
      // Price moved down: BUY — use exactInput USDC
      const safeAmt = safeAmount(amountPerGrid, bal.usdc, 'USDC', 'Grid', log)
      if (safeAmt) {
        log(`[Grid] ↓ level ${level} — buying $${safeAmt} USDC → ${token}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[Grid] ✓ buy ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      }
    } else if (level > prevLvl) {
      // Price moved up: SELL — use exactOutput USDC (receive amountPerGrid USDC, spend WETH)
      log(`[Grid] ↑ level ${level} — selling $${amountPerGrid} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amountPerGrid) })
      log(`[Grid] ✓ sell ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    }

    setState(key, { lastLevel: level })
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @RSIReversal — RSI Mean Reversion
// ═══════════════════════════════════════════════════════════════════════════

function parseRSIReversal(text) {
  const p = parseBlock(text)
  return {
    token:      (p.token ?? 'WETH').toUpperCase(),
    amount:     parseDollar(p.amount) ?? 100,
    oversold:   parsePct(p.oversold)  ?? 30,
    overbought: parsePct(p.overbought) ?? 70,
    intervalMs: parseIntervalMs(p.interval) ?? 4 * 36e5,
  }
}

async function runRSIReversal(params, log) {
  const { token, amount, oversold, overbought, intervalMs } = params
  const key = `rsi_${token}`
  log(`[RSIReversal] ${token}: buy RSI<${oversold} sell RSI>${overbought} $${amount}/signal`)

  return scheduleSkill(`RSI_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'RSIReversal')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { rsi, price_usd, atr_pct } = ind
    const s = getState(key)

    log(`[RSIReversal] ${token} RSI=${rsi?.toFixed(1)} price=$${price_usd?.toFixed(2)} ATR%=${atr_pct?.toFixed(2)}`)

    if (rsi < oversold && !s.inBuy) {
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'RSIReversal', log)
      if (!safeAmt) return
      log(`[RSIReversal] 🟢 OVERSOLD RSI=${rsi.toFixed(1)} — buying $${safeAmt} → ${token}`)
      const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
      log(`[RSIReversal] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      setState(key, { inBuy: true, inSell: false })
    }
    else if (rsi > overbought && !s.inSell) {
      // Sell: receive $amount USDC, spend whatever WETH needed (exactOutput)
      log(`[RSIReversal] 🔴 OVERBOUGHT RSI=${rsi.toFixed(1)} — selling $${amount} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
      log(`[RSIReversal] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      setState(key, { inBuy: false, inSell: true })
    }
    else {
      // Reset lock once RSI moves back toward neutral (prevents spam)
      if (s.inBuy  && rsi > oversold  + 5) setState(key, { inBuy:  false })
      if (s.inSell && rsi < overbought - 5) setState(key, { inSell: false })
      log(`[RSIReversal] neutral RSI=${rsi.toFixed(1)}, hold`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @MACross — Moving Average Crossover (Golden/Death Cross)
// ═══════════════════════════════════════════════════════════════════════════

function parseMACross(text) {
  const p = parseBlock(text)
  return {
    token:      (p.token ?? 'WETH').toUpperCase(),
    amount:     parseDollar(p.amount) ?? 150,
    intervalMs: parseIntervalMs(p.interval) ?? 4 * 36e5,
  }
}

async function runMACross(params, log) {
  const { token, amount, intervalMs } = params
  const key = `macross_${token}`
  log(`[MACross] ${token}: EMA12/26 crossover $${amount}/signal`)

  return scheduleSkill(`MACross_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'MACross')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { ema_12, ema_26, price_usd, adx } = ind
    const fastAboveNow = ema_12 > ema_26
    const s   = getState(key)
    const was = s.fastAbove ?? fastAboveNow  // initialise on first run

    log(`[MACross] ${token} EMA12=$${ema_12?.toFixed(2)} EMA26=$${ema_26?.toFixed(2)} ADX=${adx?.toFixed(1)} fast_above=${fastAboveNow}`)

    if (!was && fastAboveNow) {
      // Golden Cross — uptrend starting
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'MACross', log)
      if (safeAmt) {
        log(`[MACross] 🟡 GOLDEN CROSS — buying $${safeAmt} → ${token} (ADX=${adx?.toFixed(1)})`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[MACross] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      }
    } else if (was && !fastAboveNow) {
      // Death Cross — downtrend starting
      log(`[MACross] 💀 DEATH CROSS — selling $${amount} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
      log(`[MACross] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    } else {
      log(`[MACross] no crossover (EMA12 ${fastAboveNow ? 'above' : 'below'} EMA26)`)
    }

    setState(key, { fastAbove: fastAboveNow })
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @BBBounce — Bollinger Band Bounce
// ═══════════════════════════════════════════════════════════════════════════

function parseBBBounce(text) {
  const p = parseBlock(text)
  return {
    token:      (p.token ?? 'WETH').toUpperCase(),
    amount:     parseDollar(p.amount) ?? 100,
    touchPct:   parsePct(p.touch_threshold) ?? 1,
    intervalMs: parseIntervalMs(p.interval) ?? 2 * 36e5,
  }
}

async function runBBBounce(params, log) {
  const { token, amount, touchPct, intervalMs } = params
  const key = `bb_${token}`
  log(`[BBBounce] ${token}: buy at lower BB (±${touchPct}%), sell at upper BB`)

  return scheduleSkill(`BBBounce_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'BBBounce')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { price_usd, bb_upper, bb_lower, bb_middle, bb_pct_b, rsi } = ind
    const thF = touchPct / 100
    const s   = getState(key)

    log(`[BBBounce] ${token} $${price_usd?.toFixed(2)} %B=${(bb_pct_b * 100)?.toFixed(1)} BB[${bb_lower?.toFixed(0)}-${bb_middle?.toFixed(0)}-${bb_upper?.toFixed(0)}] RSI=${rsi?.toFixed(1)}`)

    // Lower band touch: price ≤ lower × (1 + threshold)
    if (price_usd <= bb_lower * (1 + thF) && !s.inBuy) {
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'BBBounce', log)
      if (safeAmt) {
        log(`[BBBounce] 🟢 LOWER BAND TOUCH — buying $${safeAmt} → ${token}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[BBBounce] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
        setState(key, { inBuy: true, inSell: false })
      }
    }
    // Upper band touch: price ≥ upper × (1 − threshold)
    else if (price_usd >= bb_upper * (1 - thF) && !s.inSell) {
      log(`[BBBounce] 🔴 UPPER BAND TOUCH — selling $${amount} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
      log(`[BBBounce] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      setState(key, { inBuy: false, inSell: true })
    }
    else {
      // Unlock once price moves away from bands
      if (s.inBuy  && bb_pct_b > 0.4) setState(key, { inBuy:  false })
      if (s.inSell && bb_pct_b < 0.6) setState(key, { inSell: false })
      log(`[BBBounce] inside bands (%B=${(bb_pct_b * 100)?.toFixed(1)}), hold`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @MACDCross — MACD Crossover
// ═══════════════════════════════════════════════════════════════════════════

function parseMACDCross(text) {
  const p = parseBlock(text)
  return {
    token:      (p.token ?? 'WETH').toUpperCase(),
    amount:     parseDollar(p.amount) ?? 100,
    intervalMs: parseIntervalMs(p.interval) ?? 4 * 36e5,
  }
}

async function runMACDCross(params, log) {
  const { token, amount, intervalMs } = params
  const key = `macd_${token}`
  log(`[MACDCross] ${token}: MACD 12/26/9 crossover $${amount}/signal`)

  return scheduleSkill(`MACD_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'MACDCross')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { macd_line, macd_signal, prev_macd_line, prev_macd_signal, macd_histogram } = ind

    const currAbove = macd_line > macd_signal
    const prevAbove = prev_macd_line > prev_macd_signal
    const s = getState(key)
    const lastAbove = s.macdAbove ?? prevAbove
    setState(key, { macdAbove: currAbove })

    log(`[MACDCross] ${token} MACD=${macd_line?.toFixed(4)} sig=${macd_signal?.toFixed(4)} hist=${macd_histogram?.toFixed(4)}`)

    if (!lastAbove && currAbove) {
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'MACDCross', log)
      if (safeAmt) {
        log(`[MACDCross] 🟢 BULLISH crossover — buying $${safeAmt} → ${token}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[MACDCross] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      }
    } else if (lastAbove && !currAbove) {
      log(`[MACDCross] 🔴 BEARISH crossover — selling $${amount} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
      log(`[MACDCross] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    } else {
      log(`[MACDCross] no crossover (MACD ${currAbove ? 'above' : 'below'} signal)`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @RSIBBDual — RSI + Bollinger Band Dual Confirmation
// ═══════════════════════════════════════════════════════════════════════════

function parseRSIBBDual(text) {
  const p = parseBlock(text)
  return {
    token:        (p.token ?? 'WETH').toUpperCase(),
    amount:       parseDollar(p.amount) ?? 150,
    rsiOversold:  parsePct(p.rsi_oversold)   ?? 35,
    rsiOverbought:parsePct(p.rsi_overbought)  ?? 65,
    bbTouchPct:   parsePct(p.bb_touch_pct)   ?? 2,
    intervalMs:   parseIntervalMs(p.interval) ?? 4 * 36e5,
  }
}

async function runRSIBBDual(params, log) {
  const { token, amount, rsiOversold, rsiOverbought, bbTouchPct, intervalMs } = params
  const key = `rsibbd_${token}`
  log(`[RSIBBDual] ${token}: buy RSI<${rsiOversold}+lower BB, sell RSI>${rsiOverbought}+upper BB`)

  return scheduleSkill(`RSIBBDual_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'RSIBBDual')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { rsi, price_usd, bb_upper, bb_lower, bb_pct_b } = ind
    const thF       = bbTouchPct / 100
    const nearLower = price_usd <= bb_lower * (1 + thF)
    const nearUpper = price_usd >= bb_upper * (1 - thF)
    const s         = getState(key)

    log(`[RSIBBDual] RSI=${rsi?.toFixed(1)} %B=${(bb_pct_b * 100)?.toFixed(1)} nearLower=${nearLower} nearUpper=${nearUpper}`)

    if (rsi < rsiOversold && nearLower && !s.inBuy) {
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'RSIBBDual', log)
      if (safeAmt) {
        log(`[RSIBBDual] 🟢🟢 DUAL BUY — RSI=${rsi.toFixed(1)} at lower BB — buying $${safeAmt} → ${token}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[RSIBBDual] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
        setState(key, { inBuy: true, inSell: false })
      }
    }
    else if (rsi > rsiOverbought && nearUpper && !s.inSell) {
      log(`[RSIBBDual] 🔴🔴 DUAL SELL — RSI=${rsi.toFixed(1)} at upper BB — selling $${amount} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
      log(`[RSIBBDual] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      setState(key, { inBuy: false, inSell: true })
    }
    else {
      if (s.inBuy  && rsi > rsiOversold  + 5) setState(key, { inBuy:  false })
      if (s.inSell && rsi < rsiOverbought - 5) setState(key, { inSell: false })
      // Partial signals — log for transparency
      if (rsi < rsiOversold && !nearLower)  log(`[RSIBBDual] partial: RSI oversold but not at lower BB (%B=${(bb_pct_b*100).toFixed(1)})`)
      else if (nearLower && rsi >= rsiOversold) log(`[RSIBBDual] partial: near lower BB but RSI not oversold (${rsi.toFixed(1)})`)
      else log(`[RSIBBDual] no signal`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @TrendFollow — ADX + EMA Trend Following
// ═══════════════════════════════════════════════════════════════════════════

function parseTrendFollow(text) {
  const p = parseBlock(text)
  return {
    token:        (p.token ?? 'WETH').toUpperCase(),
    amount:       parseDollar(p.amount) ?? 200,
    adxThreshold: parsePct(p.adx_threshold) ?? 25,
    intervalMs:   parseIntervalMs(p.interval) ?? 6 * 36e5,
  }
}

async function runTrendFollow(params, log) {
  const { token, amount, adxThreshold, intervalMs } = params
  const key = `trend_${token}`
  log(`[TrendFollow] ${token}: enter when ADX>${adxThreshold} + bullish EMAs, exit on weakness`)

  return scheduleSkill(`Trend_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'TrendFollow')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { adx, di_plus, di_minus, ema_20, ema_50, price_usd, atr_pct } = ind

    // Entry: strong trend + price above fast EMA + fast above slow + bullish DI
    const strongTrend  = adx > adxThreshold
    const bullishEMAs  = price_usd > ema_20 && ema_20 > ema_50
    const bullishDI    = di_plus > di_minus
    const enterSignal  = strongTrend && bullishEMAs && bullishDI

    // Exit: trend weakened, or bearish DI crossing
    const exitSignal   = adx < 20 || (!bullishEMAs && getState(key).inPosition)

    const s = getState(key)
    log(`[TrendFollow] ADX=${adx?.toFixed(1)} DI+=${di_plus?.toFixed(1)} DI-=${di_minus?.toFixed(1)} price>EMA20=${price_usd > ema_20} EMA20>EMA50=${ema_20 > ema_50}`)

    if (enterSignal && !s.inPosition) {
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'TrendFollow', log)
      if (safeAmt) {
        log(`[TrendFollow] 📈 TREND ENTRY — ADX=${adx.toFixed(1)} DI+=${di_plus.toFixed(1)} — buying $${safeAmt} → ${token}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[TrendFollow] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
        setState(key, { inPosition: true, entryPrice: price_usd })
      }
    }
    else if (exitSignal && s.inPosition) {
      log(`[TrendFollow] 📉 TREND EXIT — ADX=${adx.toFixed(1)} — selling $${amount} ${token} → USDC`)
      const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
      log(`[TrendFollow] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      setState(key, { inPosition: false, entryPrice: null })
    }
    else {
      log(`[TrendFollow] ${s.inPosition ? `holding (entry $${s.entryPrice?.toFixed(2)})` : 'no trend signal'}`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @Breakout — N-Day High Breakout with ATR Stop-Loss
// ═══════════════════════════════════════════════════════════════════════════

function parseBreakout(text) {
  const p = parseBlock(text)
  return {
    token:       (p.token ?? 'WETH').toUpperCase(),
    amount:      parseDollar(p.amount) ?? 150,
    breakoutPct: parsePct(p.breakout_pct) ?? 1,
    stopAtrMult: parseFloat(p.stop_atr_mult ?? p.stop_loss_pct ?? '2'),
    intervalMs:  parseIntervalMs(p.interval) ?? 4 * 36e5,
  }
}

async function runBreakout(params, log) {
  const { token, amount, breakoutPct, stopAtrMult, intervalMs } = params
  const key = `breakout_${token}`
  log(`[Breakout] ${token}: buy on ${breakoutPct}% break of 14d high, stop ${stopAtrMult}×ATR`)

  return scheduleSkill(`Breakout_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'Breakout')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { price_usd, recent_high_14d, atr, atr_pct, adx } = ind
    // Fallback: if 14d high is missing/zero, use current price (conservative — won't trigger breakout until new high)
    const refHigh = (recent_high_14d && recent_high_14d > 0) ? recent_high_14d : price_usd
    const breakoutLevel = refHigh * (1 + breakoutPct / 100)
    const s = getState(key)

    log(`[Breakout] ${token} $${price_usd?.toFixed(2)} 14d-high=$${refHigh?.toFixed(2)} breakout-at=$${breakoutLevel?.toFixed(2)} ATR=${atr_pct?.toFixed(2)}%`)

    if (s.inPosition) {
      // Dynamic ATR-based stop-loss
      const stopLevel = s.entryPrice - stopAtrMult * atr
      const trailStop = s.highSinceEntry ? s.highSinceEntry - stopAtrMult * atr : stopLevel
      const effectiveStop = Math.max(stopLevel, trailStop)

      // Update trailing high
      if (price_usd > (s.highSinceEntry ?? 0)) setState(key, { highSinceEntry: price_usd })

      log(`[Breakout] holding — entry $${s.entryPrice?.toFixed(2)} stop $${effectiveStop?.toFixed(2)} trail-high $${s.highSinceEntry?.toFixed(2)}`)

      if (price_usd <= effectiveStop) {
        log(`[Breakout] 🛑 STOP HIT ($${price_usd?.toFixed(2)} ≤ $${effectiveStop?.toFixed(2)}) — selling $${amount} → USDC`)
        const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_out: String(amount) })
        log(`[Breakout] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
        setState(key, { inPosition: false, entryPrice: null, highSinceEntry: null })
      }
    }
    else if (price_usd >= breakoutLevel && adx > 20) {
      // Only enter breakouts when there is some trend strength (ADX > 20)
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'Breakout', log)
      if (safeAmt) {
        log(`[Breakout] 🚀 BREAKOUT — price $${price_usd.toFixed(2)} > $${breakoutLevel.toFixed(2)} — buying $${safeAmt}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
        log(`[Breakout] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
        setState(key, { inPosition: true, entryPrice: price_usd, highSinceEntry: price_usd })
      }
    }
    else {
      log(`[Breakout] watching — need price > $${breakoutLevel?.toFixed(2)} and ADX > 20 (now ${adx?.toFixed(1)})`)
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @CategoryRotate — Performance-Based Rotation
// ═══════════════════════════════════════════════════════════════════════════

function parseCategoryRotate(text) {
  const p      = parseBlock(text)
  const tokens = (p.tokens ?? 'WETH').split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
  return {
    tokens,
    amount:     parseDollar(p.amount) ?? 200,
    rankBy:     p.rank_by ?? 'change_24h',  // 'change_24h' | 'rsi'
    topN:       parseInt(p.top_n ?? '1', 10),
    intervalMs: parseIntervalMs(p.interval) ?? 24 * 36e5,
  }
}

async function runCategoryRotate(params, log) {
  const { tokens, amount, rankBy, topN, intervalMs } = params
  const key = `catrotate_${tokens.join('_')}`
  log(`[CategoryRotate] rotating among [${tokens.join(',')}] by ${rankBy} every ${(intervalMs/36e5).toFixed(0)}h`)

  return scheduleSkill('CategoryRotate', intervalMs, async () => {
    const bal = await checkBalance(log, 'CategoryRotate')
    if (!bal.ok) return

    // Fetch indicators for all tokens in parallel
    const results = await Promise.all(tokens.map(async t => {
      try {
        const ind = await callTool('get_indicators', { token: t })
        const score = rankBy === 'rsi' ? -(ind.rsi ?? 50) : (ind.change_24h ?? 0)
        return { token: t, score, ...ind }
      } catch (e) {
        log(`[CategoryRotate] ${t} data fetch failed: ${e.message}`)
        return null
      }
    }))

    const valid   = results.filter(Boolean).sort((a, b) => b.score - a.score)
    const winners = valid.slice(0, topN)
    log(`[CategoryRotate] ranked: ${valid.map(v => `${v.token}(score=${v.score?.toFixed(2)})`).join(', ')}`)
    log(`[CategoryRotate] winner(s): ${winners.map(w => w.token).join(', ')}`)

    const s         = getState(key)
    const prevToken = s.holding ?? null

    // Skip if winner has negative momentum (when ranking by change_24h)
    const topWinner = winners[0]
    if (topWinner && rankBy === 'change_24h' && topWinner.change_24h <= 0) {
      log(`[CategoryRotate] top winner ${topWinner.token} has negative 24h (${topWinner.change_24h?.toFixed(2)}%), skip rotation`)
      return
    }

    // Sell previous holding if not in new winners
    if (prevToken && !winners.find(w => w.token === prevToken)) {
      if (!SWAPPABLE_TOKENS.has(prevToken)) {
        log(`[CategoryRotate] ⚠ ${prevToken} not swappable on-chain — cannot sell, clearing state`)
        setState(key, { holding: null })
      } else {
        log(`[CategoryRotate] rotating OUT of ${prevToken}`)
        try {
          await queueSwap({ token_in: prevToken, token_out: 'USDC', amount_out: String(amount) })
          log(`[CategoryRotate] ✓ sold ${prevToken}`)
        } catch (e) {
          log(`[CategoryRotate] sell ${prevToken} failed: ${e.message}`)
        }
      }
    }

    // Buy new winner(s) — only tokens with on-chain pools
    for (const w of winners) {
      if (w.token === prevToken) continue  // already holding
      if (!SWAPPABLE_TOKENS.has(w.token)) {
        log(`[CategoryRotate] ⚠ ${w.token} has no on-chain pool — skipping buy (use as signal token only)`)
        continue
      }
      const safeAmt = safeAmount(amount, bal.usdc, 'USDC', 'CategoryRotate', log)
      if (!safeAmt) continue
      log(`[CategoryRotate] rotating INTO ${w.token} — buying $${safeAmt}`)
      try {
        const r = await queueSwap({ token_in: 'USDC', token_out: w.token, amount_in: safeAmt })
        log(`[CategoryRotate] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      } catch (e) {
        log(`[CategoryRotate] buy ${w.token} failed: ${e.message}`)
      }
    }
    setState(key, { holding: winners[0]?.token ?? null })
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @TopNVolume — Top N Market Leaders by Volume
// ═══════════════════════════════════════════════════════════════════════════

function parseTopNVolume(text) {
  const p       = parseBlock(text)
  // Stablecoins always excluded from on-chain buys
  const exclude = new Set([
    'USDT','USDC','DAI','BUSD','TUSD','FRAX','LUSD','USDP','GUSD',
    ...(p.exclude ?? '').split(',').map(t => t.trim().toUpperCase()),
  ])
  return {
    n:          parseInt(p.n ?? '3', 10),
    amountEach: parseDollar(p.amount_each) ?? 50,
    sort:       p.sort ?? 'volume',
    exclude,
    intervalMs: parseIntervalMs(p.interval) ?? 24 * 36e5,
  }
}

async function runTopNVolume(params, log) {
  const { n, amountEach, sort, exclude, intervalMs } = params
  log(`[TopNVolume] buy top ${n} by ${sort}, $${amountEach} each`)

  return scheduleSkill('TopNVolume', intervalMs, async () => {
    const bal = await checkBalance(log, 'TopNVolume')
    if (!bal.ok) return

    const data    = await callTool('get_market_leaders', { limit: 50, sort })
    // Filter to swappable tokens only — market data tokens like BTC/SOL have no on-chain pool
    const swappable = (data.tokens ?? []).filter(t => {
      const sym = t.symbol?.toUpperCase()
      if (exclude.has(sym)) return false
      if (!SWAPPABLE_TOKENS.has(sym)) {
        // Only warn once per token to avoid log spam
        return false
      }
      return true
    })

    // If no swappable leaders found, default to buying WETH (always available)
    const leaders = swappable.length > 0
      ? swappable.slice(0, n)
      : [{ symbol: 'WETH', price_usd: null }]

    if (swappable.length === 0) {
      log(`[TopNVolume] ⚠ No swappable tokens in top leaders — falling back to WETH`)
    } else {
      log(`[TopNVolume] selected: ${leaders.map(t => `${t.symbol}($${t.price_usd?.toFixed(2)})`).join(', ')}`)
    }

    for (const t of leaders) {
      const safeAmt = safeAmount(amountEach, bal.usdc, 'USDC', 'TopNVolume', log)
      if (!safeAmt) { log(`[TopNVolume] insufficient USDC for ${t.symbol}`); continue }
      log(`[TopNVolume] buying $${safeAmt} → ${t.symbol}`)
      try {
        const r = await queueSwap({ token_in: 'USDC', token_out: t.symbol, amount_in: safeAmt })
        log(`[TopNVolume] ✓ ${t.symbol} ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      } catch (e) {
        log(`[TopNVolume] ${t.symbol} swap failed: ${e.message}`)
      }
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @AccumulateDip — Scale-Up Buying on Dips
// ═══════════════════════════════════════════════════════════════════════════

function parseAccumulateDip(text) {
  const p = parseBlock(text)
  return {
    token:        (p.token ?? 'WETH').toUpperCase(),
    baseAmount:   parseDollar(p.base_amount) ?? 50,
    dipThreshold: parsePct(p.dip_threshold) ?? 5,
    scaleFactor:  parseFloat(p.scale_factor ?? '1.5'),
    maxAmount:    parseDollar(p.max_amount)  ?? 500,
    stepPct:      parsePct(p.step_pct) ?? 5,  // % per scaling step
    intervalMs:   parseIntervalMs(p.interval) ?? 6 * 36e5,
  }
}

async function runAccumulateDip(params, log) {
  const { token, baseAmount, dipThreshold, scaleFactor, maxAmount, stepPct, intervalMs } = params
  const key = `dip_${token}`
  log(`[AccumulateDip] ${token}: base $${baseAmount} on ${dipThreshold}% dip, ×${scaleFactor} per ${stepPct}%`)

  return scheduleSkill(`Dip_${token}`, intervalMs, async () => {
    const bal = await checkBalance(log, 'AccumulateDip')
    if (!bal.ok) return

    const ind = await callTool('get_indicators', { token })
    const { price_usd, recent_high_14d, recent_high_30d } = ind
    const s = getState(key)

    // Track rolling high — use the higher of 14d/30d high or last stored high
    const refHigh = Math.max(s.trackedHigh ?? 0, recent_high_14d ?? 0, recent_high_30d ?? 0, price_usd)
    setState(key, { trackedHigh: refHigh })

    const dip = ((refHigh - price_usd) / refHigh) * 100
    log(`[AccumulateDip] ${token} $${price_usd?.toFixed(2)} ref-high $${refHigh?.toFixed(2)} dip=${dip?.toFixed(2)}%`)

    if (dip < dipThreshold) {
      log(`[AccumulateDip] dip ${dip.toFixed(2)}% < threshold ${dipThreshold}%, skip`)
      return
    }

    const steps  = Math.floor(dip / stepPct)
    const buyUsd = Math.min(baseAmount * Math.pow(scaleFactor, steps), maxAmount)
    const safeAmt = safeAmount(buyUsd, bal.usdc, 'USDC', 'AccumulateDip', log)
    if (!safeAmt) return

    log(`[AccumulateDip] 📉 ${dip.toFixed(2)}% dip (${steps} steps) — buying $${safeAmt} → ${token}`)
    const r = await queueSwap({ token_in: 'USDC', token_out: token, amount_in: safeAmt })
    log(`[AccumulateDip] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL: @TakeProfitLadder — Staged Profit Taking
// ═══════════════════════════════════════════════════════════════════════════

function parseTakeProfitLadder(text) {
  const p = parseBlock(text)
  // "targets: 10%/25%, 20%/25%, 30%/25%, 50%/25%"
  // profitPct/sellPct pairs
  const targets = (p.targets ?? '10%/25%, 20%/25%, 30%/25%')
    .split(',')
    .map(t => {
      const parts = t.trim().split('/')
      return { profitPct: parsePct(parts[0]), sellPct: parsePct(parts[1]) }
    })
    .filter(t => t.profitPct && t.sellPct)

  return {
    token:      (p.token ?? 'WETH').toUpperCase(),
    entryPrice: parseDollar(p.entry_price) ?? 0,
    targets,
    intervalMs: parseIntervalMs(p.interval) ?? 36e5,
  }
}

async function runTakeProfitLadder(params, log) {
  const { token, entryPrice, targets, intervalMs } = params
  const key = `tpl_${token}`

  if (!entryPrice || entryPrice <= 0) {
    log(`[TakeProfitLadder] entry_price required and must be > 0 — skipping`)
    return null
  }

  log(`[TakeProfitLadder] ${token} entry $${entryPrice}, ${targets.length} targets`)
  for (const t of targets) {
    log(`  Level: +${t.profitPct}% ($${(entryPrice * (1 + t.profitPct / 100)).toFixed(2)}) → sell ${t.sellPct}% of holdings`)
  }

  const triggered = new Set(getState(key).triggered ?? [])

  return scheduleSkill(`TPL_${token}`, intervalMs, async () => {
    if (triggered.size >= targets.length) {
      log(`[TakeProfitLadder] all ${targets.length} levels triggered — skill complete`)
      return
    }

    // Balance check includes gas buffer validation
    const bal = await checkBalance(log, 'TakeProfitLadder')
    if (!bal.ok) return

    const price = await callTool('get_price', { token })
    const { price_usd } = price
    log(`[TakeProfitLadder] ${token} $${price_usd?.toFixed(2)} vs entry $${entryPrice} ETH=${bal.eth.toFixed(6)}`)

    for (let i = 0; i < targets.length; i++) {
      if (triggered.has(i)) continue
      const { profitPct, sellPct } = targets[i]
      const triggerPrice = entryPrice * (1 + profitPct / 100)

      if (price_usd >= triggerPrice) {
        // Use WETH balance from checkBalance (includes gas buffer guarantee)
        const wethBal = bal.eth
        const sellableWeth = wethBal - GAS_BUFFER_ETH
        if (sellableWeth <= 0) {
          log(`[TakeProfitLadder] insufficient ${token} (${wethBal?.toFixed(6)}) at target ${i + 1}`)
          continue
        }
        // Sell sellPct of sellable WETH holdings (exactInput: spend exact WETH, receive USDC)
        const wethToSell = (sellableWeth * sellPct / 100).toFixed(6)

        log(`[TakeProfitLadder] 💰 TARGET ${i + 1} hit (+${profitPct}% at $${price_usd?.toFixed(2)}) — selling ${wethToSell} ${token} (${sellPct}% of ${sellableWeth.toFixed(6)})`)
        const r = await queueSwap({ token_in: token, token_out: 'USDC', amount_in: wethToSell })
        log(`[TakeProfitLadder] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)

        triggered.add(i)
        setState(key, { triggered: [...triggered] })
      }
    }
  }, log)
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY PARSER
// ═══════════════════════════════════════════════════════════════════════════

const SKILL_REGISTRY = {
  // Accumulation
  DCA:               { parse: parseDCA,              run: runDCA },
  VALUEAVG:          { parse: parseValueAvg,         run: runValueAvg },
  VALUEAVERAGING:    { parse: parseValueAvg,         run: runValueAvg },
  MOMENTUMDCA:       { parse: parseMomentumDCA,      run: runMomentumDCA },
  // Range
  GRID:              { parse: parseGrid,             run: runGrid },
  GRIDTRADING:       { parse: parseGrid,             run: runGrid },
  // Mean Reversion
  RSIREVERSAL:       { parse: parseRSIReversal,      run: runRSIReversal },
  RSIREV:            { parse: parseRSIReversal,      run: runRSIReversal },
  BBBOUNCE:          { parse: parseBBBounce,         run: runBBBounce },
  BOLLINGERBOUNCE:   { parse: parseBBBounce,         run: runBBBounce },
  RSIBBDUAL:         { parse: parseRSIBBDual,        run: runRSIBBDual },
  RSIBB:             { parse: parseRSIBBDual,        run: runRSIBBDual },
  // Trend
  MACROSS:           { parse: parseMACross,          run: runMACross },
  MACROSSOVER:       { parse: parseMACross,          run: runMACross },
  EMAREVERSAL:       { parse: parseMACross,          run: runMACross },
  MACDCROSS:         { parse: parseMACDCross,        run: runMACDCross },
  MACDCROSSOVER:     { parse: parseMACDCross,        run: runMACDCross },
  TRENDFOLLOW:       { parse: parseTrendFollow,      run: runTrendFollow },
  TRENDFOLLOWING:    { parse: parseTrendFollow,      run: runTrendFollow },
  BREAKOUT:          { parse: parseBreakout,         run: runBreakout },
  // Rotation & Discovery
  CATEGORYROTATE:    { parse: parseCategoryRotate,  run: runCategoryRotate },
  CATEGORYROTATION:  { parse: parseCategoryRotate,  run: runCategoryRotate },
  ROTATE:            { parse: parseCategoryRotate,  run: runCategoryRotate },
  TOPNVOLUME:        { parse: parseTopNVolume,       run: runTopNVolume },
  TOPVOLUME:         { parse: parseTopNVolume,       run: runTopNVolume },
  // Accumulation on dips
  ACCUMULATEDIP:     { parse: parseAccumulateDip,   run: runAccumulateDip },
  ACCUMULATEONDIP:   { parse: parseAccumulateDip,   run: runAccumulateDip },
  DIPCATCHER:        { parse: parseAccumulateDip,   run: runAccumulateDip },
  // Exit management
  TAKEPROFITLADDER:  { parse: parseTakeProfitLadder, run: runTakeProfitLadder },
  TAKEPROFIT:        { parse: parseTakeProfitLadder, run: runTakeProfitLadder },
  TPL:               { parse: parseTakeProfitLadder, run: runTakeProfitLadder },
}

/**
 * Parse strategy text and extract all @Skill blocks.
 * Each block starts at @SkillName and ends at the next @SkillName or end of text.
 */
function parseStrategy(text) {
  if (!text?.trim()) return []
  const found    = []
  // Split on @SkillName boundaries, keep the @SkillName with the following block
  const segments = text.split(/(?=@[A-Za-z])/)
  for (const seg of segments) {
    const m = seg.match(/^@(\w+)([\s\S]*)/)
    if (!m) continue
    const name  = m[1].toUpperCase()
    const block = m[0].trim()
    const skill = SKILL_REGISTRY[name]
    if (skill) {
      found.push({ name, block, skill })
    } else {
      console.log(`[Strategy] Unknown @${m[1]} — skipping (available: ${Object.keys(SKILL_REGISTRY).join(', ')})`)
    }
  }
  return found
}

// ── LLM Plan Compiler ─────────────────────────────────────────────────────
// LLM is called ONCE per strategy change to produce a JSON execution plan.
// The plan runs deterministically on every tick — zero LLM cost per tick.

function buildPlanSystemPrompt() {
  const stables = TOKEN_CONFIG.filter(t => t.is_stablecoin).map(t => t.symbol).join(', ')
  const nonStables = TOKEN_CONFIG.filter(t => !t.is_stablecoin).map(t => t.symbol).join(', ')

  return `You are a trading strategy compiler. Convert natural language trading strategies into a JSON execution plan.

Output ONLY valid JSON — no explanation, no markdown, no code fences. Schema:

{
  "tasks": [
    {
      "id": "short_unique_id",
      "description": "human readable summary",
      "interval": "1m",
      "stop_after": "5m",
      "type": "unconditional",
      "action": {
        "token_in": "WETH",
        "token_out": "USDC",
        "amount_in": "0.001"
      }
    },
    {
      "id": "short_unique_id",
      "description": "human readable summary",
      "interval": "1m",
      "type": "conditional",
      "condition": {
        "type": "price_above_ema",
        "token": "ETH",
        "ema": "ema_20",
        "pct": 0.001
      },
      "action": {
        "token_in": "WETH",
        "token_out": "USDC",
        "amount_out": "0.0002"
      }
    }
  ]
}

Rules:
- interval format: 30s, 1m, 5m, 15m, 30m, 1h, 4h, 6h, 12h, 24h, 1w
- Use the user's exact interval. "every minute" = "1m", "every hour" = "1h"
- If the user does NOT specify any interval or frequency (no "every", "hourly", "daily", "weekly", etc.), omit the "interval" field entirely and set max_runs:1. This means: execute the trade once immediately.
- delay (optional string, same format as interval): wait this long before first execution.
  Use for RELATIVE delays only: "after 2 minutes" → delay:"2m" | "30 seconds later" → delay:"30s"
  For tasks with both delay and interval: delay applies before the first tick only.
- execute_at (optional string, ISO 8601 UTC timestamp): schedule task at an absolute time.
  Use for ABSOLUTE times: "at 7:50 PM IST" → execute_at:"2026-04-09T14:20:00Z"
  The scheduler computes the delay automatically. Current UTC time: ${new Date().toISOString()}.
  Common timezone offsets: IST=UTC+5:30, EST=UTC-5, PST=UTC-8, CET=UTC+1, JST=UTC+9.
  If the target time has already passed, the task executes immediately.
- stop_after (optional string, same format as interval): stop executing after this total duration has elapsed.
  Examples: "stop after 1 minute" → stop_after:"1m" | "stop after 30 seconds" → stop_after:"30s"
- max_runs (optional integer): use ONLY when user specifies an exact trade count, or for one-shot trades (max_runs:1).
- Do NOT use max_runs to implement a duration limit — use stop_after instead.

PRICE WATCH PATTERN:
When user says "buy when price drops to $X" or "sell when ETH hits $Y":
- Use type: "conditional" with a price_above or price_below condition
- Set interval: "1m" (check every minute) — or user's preferred frequency
- Set max_runs: 1 (execute once when condition is met, then stop)
- This is the PriceWatch pattern — no special skill needed

Examples:
  "buy $50 of ETH when it drops below $2000" →
    { type:"conditional", interval:"1m", max_runs:1,
      condition: { type:"price_below", token:"ETH", price:2000 },
      action: { token_in:"USDC", token_out:"WETH", amount_in:"50" } }
  "sell all WETH when ETH goes above $4000" →
    { type:"conditional", interval:"1m", max_runs:1,
      condition: { type:"price_above", token:"ETH", price:4000 },
      action: { token_in:"WETH", token_out:"USDC", usd_amount_in:"all" } }
- Swappable tokens (Uniswap V3):
    Stablecoins (pegged to $1): ${stables}
    Other tokens: ${nonStables}
  WETH is also valid (ERC-20 wrapped ETH). ETH and WETH are DIFFERENT tokens.
  ETH→WETH = wrap (deposit), WETH→ETH = unwrap (withdraw). Both are valid swaps.
  Non-hub pairs are automatically routed through WETH.
- token_in/token_out MUST be one of the swappable tokens listed above — use their exact symbol
- amount_in = spend this exact amount; amount_out = receive this exact amount (use one, not both)
- Both token_in AND token_out MUST always be specified. If the user's text does not make both clear, set type to "error" with a message asking which tokens to use.
- When user says "from X" or "using X", ALWAYS use X as token_in regardless of dollar amounts
- NEVER set token_in and token_out to the same token — that is always wrong

DOLLAR AMOUNTS — critical rules:

Stablecoins (${stables}): already priced in dollars, use amount_in/amount_out directly.
All other tokens: prices fluctuate.
  → NEVER hardcode a token amount for a non-stablecoin when the user expressed a dollar value ($X).
  → ALWAYS use usd_amount_in or usd_amount_out so the agent fetches the live price at each trade execution.

The agent resolves at trade time: usd_amount_in → amount_in = $X / live_price(token_in)
                                  usd_amount_out → amount_out = $X / live_price(token_out)

Decision table — look at which side is a stablecoin:

  token_in=STABLECOIN, token_out=anything → amount_in:"X"
  token_in=NON-STABLE, token_out=STABLECOIN → amount_out:"X"
  token_in=NON-STABLE, token_out=NON-STABLE, spend $X → usd_amount_in:"X"
  token_in=NON-STABLE, token_out=NON-STABLE, receive $X → usd_amount_out:"X"

- For unconditional tasks, omit the "condition" field
- For conditional tasks, include one condition object
- Condition token can be any supported indicator token (not just swappable ones)

Condition types:
- price_above_ema: { type, token, ema ("ema_9"|"ema_12"|"ema_20"|"ema_26"|"ema_50"), pct }
- price_below_ema: { type, token, ema, pct }
- rsi_above: { type, token, level (0-100) }
- rsi_below: { type, token, level (0-100) }
- price_above: { type, token, price }
- price_below: { type, token, price }
- macd_bullish: { type, token }
- macd_bearish: { type, token }
- bb_below_lower: { type, token }
- bb_above_upper: { type, token }
- adx_above: { type, token, level }
- change_24h_above: { type, token, pct }
- change_24h_below: { type, token, pct }
- fear_greed_above: { type, level (0-100) } — crypto Fear & Greed Index above threshold (no token needed)
- fear_greed_below: { type, level (0-100) } — crypto Fear & Greed Index below threshold (no token needed)
  Scale: 0-24=Extreme Fear, 25-49=Fear, 50=Neutral, 51-74=Greed, 75-100=Extreme Greed
  Examples: "when market is fearful" → fear_greed_below level:50 | "when market is greedy" → fear_greed_above level:75
- and: { type: "and", conditions: [...] }
- or: { type: "or", conditions: [...] }

Available fields from get_indicators: price_usd, ema_9, ema_12, ema_20, ema_26, ema_50, rsi, macd, macd_signal, bb_upper, bb_lower, bb_middle, adx, atr_pct, change_24h`
}

// Plan cache — keyed on strategy text, TTL-based to pick up prompt improvements on restart
const PLAN_CACHE_TTL_MS = 60 * 60_000 // recompile after 1 hour even if strategy text unchanged
let planCache = { text: '', tasks: [], cachedAt: 0 }

async function compilePlan(strategyText, log) {
  const age = Date.now() - (planCache.cachedAt ?? 0)
  if (planCache.text === strategyText && age < PLAN_CACHE_TTL_MS) return planCache.tasks

  log('🧠 compiling strategy plan (one-time)...')

  let raw = ''
  try {
    if (AI_PROVIDER === 'vertex') {
      const accessToken = await getVertexAccessToken()
      const model    = 'claude-haiku-4-5@20251001'
      const endpoint = VERTEX_REGION === 'global'
        ? `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/global/publishers/anthropic/models/${model}:rawPredict`
        : `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/anthropic/models/${model}:rawPredict`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          anthropic_version: 'vertex-2023-10-16', max_tokens: 2048,
          system: buildPlanSystemPrompt(),
          messages: [{ role: 'user', content: strategyText }],
        }),
      })
      const d = await res.json()
      if (d.error) throw new Error(`Vertex: ${d.error.message ?? JSON.stringify(d.error)}`)
      raw = d.content?.[0]?.text?.trim() ?? ''
    } else if (AI_PROVIDER === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': AI_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2048,
          system: buildPlanSystemPrompt(),
          messages: [{ role: 'user', content: strategyText }],
        }),
      })
      const d = await res.json()
      if (d.error) throw new Error(`Anthropic: ${d.error.message}`)
      raw = d.content?.[0]?.text?.trim() ?? ''
    } else {
      const baseUrl = AI_PROVIDER === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'
      const model   = AI_PROVIDER === 'openrouter' ? 'anthropic/claude-haiku-4-5' : 'gpt-4o-mini'
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 2048,
          messages: [{ role: 'system', content: buildPlanSystemPrompt() }, { role: 'user', content: strategyText }],
        }),
      })
      const d = await res.json()
      if (d.error) throw new Error(`${AI_PROVIDER}: ${d.error.message}`)
      raw = d.choices?.[0]?.message?.content?.trim() ?? ''
    }
  } catch (e) {
    throw new Error(`Plan compilation failed: ${e.message}`)
  }

  // Strip markdown fences if present
  raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

  let plan
  try {
    plan = JSON.parse(raw)
  } catch {
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`)
  }

  const tasks = plan.tasks ?? []

  // ── Post-process: extract stop conditions directly from strategy text ─────
  // The LLM gets the math wrong for "stop after X" → "max_runs: N" (off-by-one).
  // We detect time-based stop conditions in the raw text and inject stop_after ourselves,
  // removing any LLM-computed max_runs so the scheduler computes the exact count in JS.
  const stopAfterMatch = strategyText.match(
    /stop\s+after\s+([\d.]+)\s*(second|minute|hour|sec|min|hr|s|m|h)s?\b/i,
  )
  if (stopAfterMatch) {
    const n   = stopAfterMatch[1]
    const raw = stopAfterMatch[2].toLowerCase()
    const unit = raw.startsWith('s') ? 's' : raw.startsWith('m') ? 'm' : 'h'
    const stopAfter = `${n}${unit}` // e.g. "1m", "30s", "2h"
    for (const task of tasks) {
      task.stop_after = stopAfter
      delete task.max_runs // never trust LLM-computed integer for time-based limits
    }
  }

  planCache = { text: strategyText, tasks, cachedAt: Date.now() }
  log(`📋 plan compiled: ${tasks.length} task(s) — ${tasks.map(t => `${t.id}(${t.interval ?? 'once'})`).join(', ')}`)
  tasks.forEach(t => log(`   ${t.type === 'unconditional' ? '⏰' : '🔍'} [${t.id}] ${t.description}`))
  return tasks
}

// ── Condition evaluator ────────────────────────────────────────────────────
// Pure deterministic logic — zero LLM cost

const indicatorFetchCache = new Map() // token → { data, ts } — 30s TTL per tick

async function fetchIndicatorsForTick(token) {
  const cached = indicatorFetchCache.get(token)
  if (cached && Date.now() - cached.ts < 30_000) return cached.data
  const data = await callTool('get_indicators', { token })
  indicatorFetchCache.set(token, { data, ts: Date.now() })
  return data
}

// ── Fear & Greed Index (alternative.me) ───────────────────────────────────

let _fngCache = { value: null, fetchedAt: 0 }
const FNG_CACHE_TTL = 10 * 60_000 // cache for 10 minutes (updates daily anyway)

async function fetchFearGreedIndex() {
  if (_fngCache.value !== null && Date.now() - _fngCache.fetchedAt < FNG_CACHE_TTL) return _fngCache.value
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1')
    const d = await res.json()
    const val = parseInt(d?.data?.[0]?.value, 10)
    if (!isNaN(val)) {
      _fngCache = { value: val, fetchedAt: Date.now() }
      console.log(`[FnG] Fear & Greed Index: ${val} (${d.data[0].value_classification})`)
      return val
    }
  } catch (e) { console.error(`[FnG] fetch failed: ${e.message}`) }
  return _fngCache.value ?? 50 // default to neutral on failure
}

async function evalCondition(cond) {
  if (cond.type === 'and') {
    for (const c of cond.conditions) { if (!(await evalCondition(c))) return false }
    return true
  }
  if (cond.type === 'or') {
    for (const c of cond.conditions) { if (await evalCondition(c)) return true }
    return false
  }

  const ind   = await fetchIndicatorsForTick(cond.token ?? 'ETH')
  const price = ind.price_usd

  switch (cond.type) {
    case 'price_above_ema': {
      const ema = ind[cond.ema ?? 'ema_20']
      return ema > 0 && (price - ema) / ema * 100 >= (cond.pct ?? 0)
    }
    case 'price_below_ema': {
      const ema = ind[cond.ema ?? 'ema_20']
      return ema > 0 && (ema - price) / ema * 100 >= (cond.pct ?? 0)
    }
    case 'rsi_above':         return (ind.rsi ?? 50) >= (cond.level ?? 70)
    case 'rsi_below':         return (ind.rsi ?? 50) <= (cond.level ?? 30)
    case 'price_above':       return price >= (cond.price ?? 0)
    case 'price_below':       return price <= (cond.price ?? 0)
    case 'macd_bullish':      return (ind.macd ?? 0) > (ind.macd_signal ?? 0)
    case 'macd_bearish':      return (ind.macd ?? 0) < (ind.macd_signal ?? 0)
    case 'bb_below_lower':    return price <= (ind.bb_lower ?? 0)
    case 'bb_above_upper':    return price >= (ind.bb_upper ?? Infinity)
    case 'adx_above':         return (ind.adx ?? 0) >= (cond.level ?? 25)
    case 'change_24h_above':  return (ind.change_24h ?? 0) >= (cond.pct ?? 0)
    case 'change_24h_below':  return (ind.change_24h ?? 0) <= (cond.pct ?? 0)
    case 'fear_greed_above':  { const fng = await fetchFearGreedIndex(); return fng >= (cond.level ?? 50) }
    case 'fear_greed_below':  { const fng = await fetchFearGreedIndex(); return fng <= (cond.level ?? 50) }
    default:
      console.log(`[Condition] unknown type: ${cond.type}`)
      return false
  }
}

// ── Task runner ────────────────────────────────────────────────────────────

async function runTask(task, log) {
  // ── Normalize & validate action fields ──────────────────────────────────
  if (task.action) {
    if (task.action.token_in)  task.action.token_in  = task.action.token_in.toUpperCase()
    if (task.action.token_out) task.action.token_out = task.action.token_out.toUpperCase()
  }
  const action = task.action ?? {}
  if (!action.token_in || !action.token_out) {
    log(`[${task.id}] ⚠ missing token_in or token_out — skip`)
    return
  }
  if (action.token_in === action.token_out) {
    log(`[${task.id}] ⚠ token_in === token_out (${action.token_in}) — skip`)
    return
  }
  if (!action.amount_in && !action.amount_out && !action.usd_amount_in && !action.usd_amount_out) {
    log(`[${task.id}] ⚠ no amount specified — skip`)
    return
  }

  // ── 5-minute timeout guard ──────────────────────────────────────────────
  const TASK_TIMEOUT_MS = 5 * 60_000
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), TASK_TIMEOUT_MS)

  try { await _runTaskInner(task, log) }
  finally { clearTimeout(timeoutId) }
}

async function _runTaskInner(task, log) {
  // Evaluate condition if present
  if (task.condition) {
    let met = false
    try { met = await evalCondition(task.condition) } catch (e) {
      log(`[${task.id}] condition error: ${e.message}`)
      return
    }
    if (!met) {
      log(`[${task.id}] condition not met — skip`)
      return
    }
    log(`[${task.id}] ✅ condition met`)
  }

  // Execute swap — resolve usd_amount_in/usd_amount_out to live token amounts for non-stablecoins.
  // The plan stores dollar values; actual token amounts are calculated fresh at every trade.
  const { token_in, token_out, amount_in, amount_out, usd_amount_in, usd_amount_out } = task.action

  async function resolveUsd(usdAmt, token, label) {
    const sym = (token ?? '').toUpperCase()
    if (isStable(sym)) return usdAmt  // pegged to $1, no conversion needed
    try {
      // Use on-chain Quoter for accurate pool price (works on testnet too)
      const quote = await callTool('get_quote', { token_in: token, token_out: 'USDC', usd_amount: usdAmt })
      if (quote?.amountIn) {
        const poolPrice = quote.poolPrice ? `$${quote.poolPrice.toFixed(2)}` : '?'
        log(`[${task.id}] 💱 $${usdAmt} → ${quote.amountIn} ${token} (pool price: ${poolPrice}, ${label})`)
        return quote.amountIn
      }
      throw new Error('no quote returned')
    } catch (e) {
      // Fallback to CoinGecko price
      try {
        const priceData = await callTool('get_price', { token })
        const price = priceData?.price_usd
        if (!price || price <= 0) throw new Error(`no price for ${token}`)
        const resolved = (parseFloat(usdAmt) / price).toFixed(8)
        log(`[${task.id}] 💱 $${usdAmt} ÷ $${price.toFixed(2)} = ${resolved} ${token} (${label}, fallback)`)
        return resolved
      } catch (e2) {
        log(`[${task.id}] ⚠ price fetch failed for ${token}: ${e2.message} — skipping trade`)
        return null
      }
    }
  }

  let resolvedAmountIn  = amount_in
  let resolvedAmountOut = amount_out

  if (usd_amount_in) {
    resolvedAmountIn = await resolveUsd(usd_amount_in, token_in, 'amount_in')
    if (resolvedAmountIn === null) return
  }
  if (usd_amount_out) {
    resolvedAmountOut = await resolveUsd(usd_amount_out, token_out, 'amount_out')
    if (resolvedAmountOut === null) return
  }

  log(`[${task.id}] 🔄 ${token_in} → ${token_out} ${resolvedAmountIn ? `spend ${resolvedAmountIn}` : `receive ${resolvedAmountOut}`}`)
  try {
    const r = await queueSwap({ token_in, token_out, amount_in: resolvedAmountIn, amount_out: resolvedAmountOut })
    if (r.status === 'strategy_stopped') {
      log(`[${task.id}] 🛑 strategy stopped — halting all timers`)
      for (const t of activeTimers) clearInterval(t)
      activeTimers = []
      return
    }
    log(`[${task.id}] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
  } catch (e) {
    const msg = e?.message ?? String(e)
    // Classify: balance/approval errors are soft (won't improve on retry — skip circuit breaker)
    // Gas/nonce/STF/timeout errors are hard (unexpected — count toward circuit breaker)
    const isSoftFailure = (
      msg.includes('Insufficient') ||
      msg.includes('insufficient') ||
      msg.includes('balance') ||
      msg.includes('Unsupported token') ||
      msg.includes('Invalid swap amount')
    )
    if (isSoftFailure) {
      log(`[${task.id}] ⚠ skipped: ${msg.slice(0, 120)}`)
      // Don't re-throw — soft failures don't count toward the circuit-breaker pause limit
    } else {
      log(`[${task.id}] ❌ swap failed: ${msg.slice(0, 200)}`)
      throw e // re-throw so scheduleSkill can count it toward MAX_RETRIES
    }
  }
}

// ── Apply strategy (called on every stream update) ────────────────────────

let currentPortfolio = null
let _lastAppliedStrategy = ''

async function applyStrategy(strategyText, log) {
  // Skip if same strategy is already running with active timers — don't reset delayed timers
  if (strategyText?.trim() === _lastAppliedStrategy && activeTimers.length > 0) return

  for (const t of activeTimers) { clearInterval(t); clearTimeout(t) }
  activeTimers = []
  indicatorFetchCache.clear()
  _taskInFlight.clear() // cancel in-flight guard so fresh strategy starts clean

  if (!strategyText?.trim()) {
    _lastAppliedStrategy = ''
    log('📭 no strategy — agent idle')
    return
  }

  // Always prefer LLM planner — handles all formats (natural language, @Skill, mixed)
  if (AI_API_KEY) {
    let tasks
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        tasks = await compilePlan(strategyText, log)
        break
      } catch (e) {
        if (attempt === 3) { log(`⚠ plan compilation failed after 3 attempts: ${e.message}`); return }
        log(`⚠ plan compilation failed (attempt ${attempt}/3) — retrying in ${attempt * 2}s...`)
        await new Promise(r => setTimeout(r, attempt * 2_000))
      }
    }

    if (!tasks.length) {
      log('⚠ plan has no tasks — agent idle')
      return
    }

    _lastAppliedStrategy = strategyText.trim()

    // Separate one-shot tasks from recurring.
    // A task is one-shot if: no interval specified, or max_runs === 1.
    // Never default-repeat a trade the user didn't ask to repeat.
    const oneShotTasks = []
    const recurringTasks = []
    for (const task of tasks) {
      if (!task.interval || task.max_runs === 1) {
        oneShotTasks.push(task)
      } else {
        recurringTasks.push(task)
      }
    }

    // Execute one-shot tasks (immediately or after delay)
    if (oneShotTasks.length) {
      log(`🚀 executing ${oneShotTasks.length} one-shot task(s)`)
      const oneShotPromises = oneShotTasks.map(task => {
        // execute_at (absolute ISO timestamp) takes priority over delay (relative)
        let delayMs = 0
        if (task.execute_at) {
          const targetMs = new Date(task.execute_at).getTime()
          delayMs = Math.max(0, targetMs - Date.now())
          log(`[${task.id}] ⏳ scheduled for ${task.execute_at} — will execute in ${Math.round(delayMs / 1000)}s`)
        } else if (task.delay) {
          delayMs = parseIntervalMs(task.delay) ?? 0
        }
        if (delayMs > 0) {
          if (!task.execute_at) log(`[${task.id}] ⏳ delayed by ${task.delay} — will execute in ${delayMs / 1000}s`)
          return new Promise((resolve) => {
            const t = setTimeout(() => {
              runTask(task, log).catch(e => log(`[${task.id}] error: ${e.message}`)).then(resolve)
            }, delayMs)
            activeTimers.push(t)
          })
        }
        return runTask(task, log).catch(e => log(`[${task.id}] error: ${e.message}`))
      })
      // If there are no recurring tasks, clear strategy after all one-shots finish
      if (recurringTasks.length === 0) {
        const deployedStrategy = strategyText.trim()
        Promise.all(oneShotPromises).then(() => {
          if (_lastAppliedStrategy !== deployedStrategy) {
            log('✅ one-shot tasks completed — new strategy already active, skipping clear')
            return
          }
          log('✅ all one-shot tasks completed — clearing active strategy')
          _lastAppliedStrategy = ''
          activeTimers = []
          fetch(`${TDS_MCP_URL}/strategy`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${TDS_AUTH_TOKEN}` },
          }).catch(() => {})
        })
      }
    }

    // If there are no tasks at all, clear strategy
    if (oneShotTasks.length === 0 && recurringTasks.length === 0) {
      log('⚠ no executable tasks — clearing strategy')
      fetch(`${TDS_MCP_URL}/strategy`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TDS_AUTH_TOKEN}` },
      }).catch(() => {})
    }

    // Group recurring tasks by interval and schedule each group
    const byInterval = new Map()
    for (const task of recurringTasks) {
      const ms = parseIntervalMs(task.interval) ?? 5 * 60_000
      if (!byInterval.has(ms)) byInterval.set(ms, [])
      byInterval.get(ms).push(task)
    }

    const ivLabel = ms => ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`

    for (const [ms, intervalTasks] of byInterval) {
      // Resolve max_runs: explicit count OR computed from stop_after duration
      const resolvedMax = (task) => {
        if (task.max_runs != null) return task.max_runs
        if (task.stop_after) {
          const stopMs = parseIntervalMs(task.stop_after)
          if (stopMs) return Math.floor(stopMs / ms) // floor: t=stop_ms excluded
        }
        return Infinity
      }

      // Track run counts for max_runs enforcement
      const runCounts = new Map(intervalTasks.map(t => [t.id, 0]))
      const maxLabel = intervalTasks.map(t => {
        const m = resolvedMax(t)
        return m === Infinity ? '∞' : `max ${m}`
      }).join('/')
      log(`⏰ scheduling ${intervalTasks.length} task(s) every ${ivLabel(ms)} [runs: ${maxLabel}]`)

      let timerId
      const tick = () => {
        indicatorFetchCache.clear() // fresh indicators each tick
        let anyActive = false
        for (const task of intervalTasks) {
          const maxRuns = resolvedMax(task)
          const ran = runCounts.get(task.id) ?? 0
          if (ran >= maxRuns) continue

          // Skip-if-busy: if previous swap is still confirming on-chain, don't queue another.
          // Without this, slow chains cause a backlog of queued swaps behind the wallet lock.
          if (_taskInFlight.has(task.id)) {
            log(`[${task.id}] ⏩ previous run still in-flight — skipping tick`)
            anyActive = true // keep schedule alive
            continue
          }

          anyActive = true
          runCounts.set(task.id, ran + 1)
          _taskInFlight.add(task.id)
          runTask(task, log)
            .catch(e => log(`[${task.id}] error: ${e.message}`))
            .finally(() => _taskInFlight.delete(task.id))
        }
        // Stop interval when all tasks have hit their max_runs
        if (!anyActive) {
          log(`⏹ all tasks completed — stopping schedule`)
          clearInterval(timerId)
          activeTimers = activeTimers.filter(t => t !== timerId)
          // If no timers remain, strategy is fully complete — notify server to clear UI
          if (activeTimers.length === 0) {
            log('✅ strategy fully completed — clearing active strategy')
            fetch(`${TDS_MCP_URL}/strategy`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${TDS_AUTH_TOKEN}` },
            }).catch(() => {})
          }
        }
      }
      // Check if any task in this group has a delay or execute_at
      const maxDelayMs = Math.max(...intervalTasks.map(t => {
        if (t.execute_at) return Math.max(0, new Date(t.execute_at).getTime() - Date.now())
        return t.delay ? (parseIntervalMs(t.delay) ?? 0) : 0
      }))

      const startSchedule = () => {
        // Assign timerId BEFORE calling tick() so clearInterval(timerId) inside tick() works correctly
        timerId = setInterval(tick, ms)
        activeTimers.push(timerId)
        tick() // first tick immediately (timerId is now defined)
      }

      if (maxDelayMs > 0) {
        log(`⏳ schedule delayed by ${maxDelayMs / 1000}s`)
        const dt = setTimeout(startSchedule, maxDelayMs)
        activeTimers.push(dt)
      } else {
        startSchedule()
      }
    }
    return
  }

  // Fallback: no AI_API_KEY — use @Skill regex parser
  const skills = parseStrategy(strategyText)
  if (skills.length) {
    log(`📋 skill mode (no AI key): ${skills.length} skill(s) — [${skills.map(s => s.name).join(', ')}]`)
    for (const { name, block, skill } of skills) {
      ;(async () => {
        try {
          const params = skill.parse(block)
          if (!params) { log(`[${name}] ⚠ parse failed — check parameters`); return }
          const timer = await skill.run(params, log)
          if (timer) activeTimers.push(timer)
        } catch (e) { log(`[${name}] startup error: ${e.message}`) }
      })()
    }
  } else {
    log('⚠ AI_API_KEY not set — use @SkillName directives or set AI_API_KEY')
  }
}

// ── SSE stream connection ─────────────────────────────────────────────────

async function connectStream(log) {
  log('connecting to strategy stream...')
  try {
    const res = await fetch(`${TDS_MCP_URL}/strategy/stream`, {
      headers: { Authorization: `Bearer ${TDS_AUTH_TOKEN}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    log('✅ strategy stream connected')
    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let   buf     = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const { strategy } = JSON.parse(line.slice(6))
          applyStrategy(strategy, log).catch(e => log(`applyStrategy error: ${e.message}`))
        } catch {}
      }
    }
  } catch (e) {
    log(`stream error: ${e.message} — reconnecting in 5s`)
  }
  setTimeout(() => connectStream(log), 5_000)
}

// ── Agent entry point ─────────────────────────────────────────────────────

export async function startAgent(log) {
  if (!TDS_AUTH_TOKEN) throw new Error('TDS_AUTH_TOKEN env var is required')

  log('TDS Agent v2.0 starting...')

  // Load dynamic token config from MCP server
  log('loading token config...')
  const tokenData = await loadTokenConfig()
  if (tokenData) {
    const stableCount = TOKEN_CONFIG.filter(t => t.is_stablecoin).length
    log(`tokens loaded: ${SWAPPABLE_SYMBOLS.length} symbols, ${stableCount} stablecoins`)
  } else {
    log('⚠ using default token config — /tokens/config unavailable')
  }

  // Load AI config from MCP server (set by user in terminal setup page)
  log('loading agent config...')
  const cfg = await loadAgentConfig()
  AI_API_KEY        = cfg.AI_API_KEY
  VERTEX_PROJECT_ID = cfg.VERTEX_PROJECT_ID
  VERTEX_SA_JSON    = cfg.VERTEX_SA_JSON
  AI_PROVIDER       = cfg.AI_PROVIDER
  ACP_API_KEY       = cfg.ACP_API_KEY   ?? ''
  ACP_WALLET        = cfg.ACP_WALLET   ?? ''
  ACP_ENABLED       = !!(cfg.ACP_ENABLED && ACP_API_KEY && TDS_SELLER_ADDRESS)
  log(`ai provider: ${AI_PROVIDER}`)
  if (ACP_ENABLED) {
    log(`ACP mode: enabled (seller: ${TDS_SELLER_ADDRESS.slice(0, 10)}...)`)
    if (ACP_WALLET) log(`ACP wallet: ${ACP_WALLET} (auto-fund enabled)`)
    else log(`ACP wallet: not set (auto-fund disabled)`)
  }
  else log('ACP mode: disabled (direct MCP)')

  // Wait for wallet (retries every 5s — wallet created by terminal on sign-in)
  log('waiting for wallet...')
  let wallet = null
  while (!wallet) {
    try {
      const res = await callTool('wallet_get')
      if (res.address) { wallet = res; break }
      log(`wallet_get returned no address: ${JSON.stringify(res)}`)
    } catch (e) {
      log(`wallet_get error: ${e.message}`)
    }
    await new Promise(r => setTimeout(r, 5_000))
  }
  log(`wallet: ${wallet.address}`)

  // Initial portfolio fetch
  currentPortfolio = await callTool('get_portfolio').catch(() => null)
  if (currentPortfolio) {
    const ethUsd = currentPortfolio.tokens?.find(t => t.symbol === 'ETH')?.usd_value ?? '?'
    log(`portfolio: ${currentPortfolio.eth} ETH ($${ethUsd}) + ${parseFloat(currentPortfolio.usdc).toFixed(2)} USDC = $${currentPortfolio.total_usd} total`)
  } else {
    const bal = await callTool('get_balance').catch(() => ({ eth: '?', usdc: '?' }))
    log(`balance: ${bal.eth} ETH  ${bal.usdc} USDC`)
  }

  // Heartbeat — keeps terminal "connected" indicator alive
  startHeartbeat(log)

  // Subscribe to strategy stream — all updates handled here
  connectStream(log)
}

// ── Test exports (non-production, used by test-skills.mjs only) ────────────
export { SKILL_REGISTRY, parseStrategy, applyStrategy }
export function clearAllState() { for (const k of Object.keys(STATE)) delete STATE[k] }
export function setSkillState(key, obj) { STATE[key] = { ...STATE[key], ...obj } }
