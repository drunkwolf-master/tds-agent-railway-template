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

// ── Serial transaction queue ───────────────────────────────────────────────
// Prevents nonce collisions when multiple skills fire simultaneously.
// All execute_swap calls are serialized through this promise chain.
let _txQueue = Promise.resolve()
function queueSwap(params) {
  const result = _txQueue.then(() => callTool('execute_swap', params))
  _txQueue = result.catch(() => {})  // keep queue alive on failure
  return result
}

const TDS_AUTH_TOKEN = process.env.TDS_AUTH_TOKEN ?? ''
const TDS_MCP_URL    = (process.env.TDS_MCP_URL ?? 'https://tds-mcp-production.up.railway.app').replace(/\/$/, '')

// Single canonical stablecoin set — never redefine this inline elsewhere in this file.
const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'USDBC'])

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
      }
    }
  } catch {}
  return { AI_API_KEY: '', VERTEX_PROJECT_ID: '', VERTEX_SA_JSON: '', AI_PROVIDER: 'openai' }
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

// Tokens that have on-chain pools on this deployment (Base Sepolia testnet).
// All other tokens from market data can be used as SIGNALS only, not for swaps.
// On mainnet Base, expand this set as new pools are deployed.
const SWAPPABLE_TOKENS = new Set(['WETH', 'ETH', 'USDC', 'USDT'])

// ── Utility ────────────────────────────────────────────────────────────────

function parseIntervalMs(s) {
  if (!s) return null
  const m = String(s).trim().toLowerCase().match(/^([\d.]+)\s*(s|m|h|d|w)(?:ec|in|r|ay|eek)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  return n * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]] ?? 36e5)
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

// ── Safety Helpers ─────────────────────────────────────────────────────────

/**
 * Pre-trade balance check.
 * Returns { ok, eth, usdc, ethUsd, totalUsd, ethPrice }
 * Caller should abort if !ok.
 */
async function checkBalance(log, context = '') {
  try {
    const p = await callTool('get_portfolio')
    const eth      = parseFloat(p.eth  ?? 0)
    const usdc     = parseFloat(p.usdc ?? 0)
    const ethPrice = parseFloat(p.eth_price ?? 0)
    const totalUsd = parseFloat(p.total_usd ?? 0)
    if (eth < GAS_BUFFER_ETH) {
      log(`[${context}] ⚠ ETH balance ${eth.toFixed(4)} below gas buffer ${GAS_BUFFER_ETH} — skipping`)
      return { ok: false, eth, usdc, ethUsd: eth * ethPrice, totalUsd, ethPrice }
    }
    return { ok: true, eth, usdc, ethUsd: eth * ethPrice, totalUsd, ethPrice }
  } catch (e) {
    log(`[${context}] balance check failed: ${e.message}`)
    return { ok: false, eth: 0, usdc: 0, ethUsd: 0, totalUsd: 0, ethPrice: 0 }
  }
}

/**
 * Cap a USDC buy amount to MAX_POSITION_PCT of available USDC.
 * Returns the safe amount (string) or null if insufficient.
 */
function safeUsdc(requestedUSD, availableUsdc, context, log) {
  if (availableUsdc <= 0) {
    log(`[${context}] no USDC available, skip`)
    return null
  }
  const max = availableUsdc * MAX_POSITION_PCT
  if (requestedUSD > max) {
    log(`[${context}] requested $${requestedUSD} > available $${max.toFixed(4)} — capping to $${max.toFixed(4)}`)
  }
  return Math.min(requestedUSD, max).toFixed(6)
}

/**
 * Wrap a skill run function with retry and failure-pause logic.
 * Returns a setInterval timer ID.
 */
function scheduleSkill(skillName, intervalMs, checkFn, log) {
  const key = `${skillName}_failures`
  let paused = false

  async function tick() {
    if (paused) return
    const s = getState(key)
    if ((s.failures ?? 0) >= MAX_RETRIES) {
      if (!s.pauseLogged) {
        log(`[${skillName}] ⛔ paused after ${MAX_RETRIES} consecutive failures — update strategy to resume`)
        setState(key, { pauseLogged: true })
      }
      return
    }
    try {
      await checkFn()
      setState(key, { failures: 0 })
    } catch (e) {
      const failures = (getState(key).failures ?? 0) + 1
      setState(key, { failures, pauseLogged: false })
      log(`[${skillName}] ❌ error (${failures}/${MAX_RETRIES}): ${e.message}`)
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
  // Format 1: "@DCA buy $X TOKEN_IN -> TOKEN_OUT every INTERVAL"
  const mArrow = text.match(/@DCA\s+buy\s+\$?([\d.]+)\s+(\w+)\s*[-→>]+\s*(\w+)\s+every\s+/i)
  if (mArrow) {
    const [, amount, tokenIn, tokenOut] = mArrow
    const iv = text.match(/every\s+(.+)/i)?.[1]
    return { amount: parseDollar(amount), tokenIn: tokenIn.toUpperCase(),
             tokenOut: tokenOut.toUpperCase(), exactOutput: false,
             intervalMs: parseIntervalMs(iv) ?? 6 * 36e5 }
  }
  // Format 2: "@DCA buy $X TOKEN_OUT with TOKEN_IN every INTERVAL"
  // exactOutput when TOKEN_OUT is a stablecoin (receive exact amount)
  const mWith = text.match(/@DCA\s+buy\s+\$?([\d.]+)\s+(\w+)\s+with\s+(\w+)\s+every\s+/i)
  if (mWith) {
    const [, amount, tokenOut, tokenIn] = mWith
    const tOut = tokenOut.toUpperCase()
    const iv   = text.match(/every\s+(.+)/i)?.[1]
    return { amount: parseDollar(amount), tokenIn: tokenIn.toUpperCase(),
             tokenOut: tOut, exactOutput: STABLECOINS.has(tOut),
             intervalMs: parseIntervalMs(iv) ?? 6 * 36e5 }
  }
  // Format 3: "@DCA buy $X TOKEN every INTERVAL" — single token, assume WETH↔USDC
  const mSingle = text.match(/@DCA\s+buy\s+\$?([\d.]+)\s+(\w+)\s+every\s+/i)
  if (mSingle) {
    const [, amount, token] = mSingle
    const tok = token.toUpperCase()
    const iv  = text.match(/every\s+(.+)/i)?.[1]
    const isStable = STABLES.has(tok)
    const tokenIn  = isStable ? 'WETH' : 'USDC'
    const tokenOut = isStable ? 'USDC' : tok   // normalize stables to USDC for swap
    return { amount: parseDollar(amount), tokenIn, tokenOut, exactOutput: false,
             intervalMs: parseIntervalMs(iv) ?? 6 * 36e5 }
  }
  // Block format
  const p = parseBlock(text)
  if (!p.token_in && !p.token_out && !p.amount) return null
  return {
    amount:      parseDollar(p.amount) ?? 50,
    tokenIn:     (p.token_in  ?? 'USDC').toUpperCase(),
    tokenOut:    (p.token_out ?? 'WETH').toUpperCase(),
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

    // Buy: stablecoin → WETH (exactInput: spend exact stable)
    if (!exactOutput && STABLECOINS.has(tokenIn)) {
      const safeAmt = safeUsdc(amount, bal.usdc, 'DCA', log)
      if (!safeAmt) return
      log(`[DCA] buying ${safeAmt} ${tokenIn} → ${tokenOut}`)
      const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_in: safeAmt })
      log(`[DCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    }
    // Sell: WETH → stablecoin (exactInput: spend exact WETH)
    else if (!exactOutput && !STABLECOINS.has(tokenIn)) {
      const wethAvail = bal.eth - GAS_BUFFER_ETH
      const wethAmt   = Math.min(amount / (bal.ethPrice || 1), wethAvail * MAX_POSITION_PCT)
      if (wethAmt < 0.000001) { log(`[DCA] insufficient WETH`); return }
      log(`[DCA] selling ${wethAmt.toFixed(6)} ${tokenIn} → ${tokenOut}`)
      const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_in: wethAmt.toFixed(6) })
      log(`[DCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
    }
    // ExactOutput: get exact amount of tokenOut (works for either direction)
    else {
      log(`[DCA] exactOutput: receive ${amount} ${tokenOut}`)
      const r = await queueSwap({ token_in: tokenIn, token_out: tokenOut, amount_out: String(amount) })
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
    const safeAmt = safeUsdc(buyUsd, bal.usdc, 'ValueAvg', log)
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
  const tokenOut = (p.token_out ?? p.token ?? 'WETH').toUpperCase()
  const tokenIn  = (p.token_in ?? (tokenOut === 'USDC' ? 'WETH' : 'USDC')).toUpperCase()
  // signal token is always the volatile asset (WETH/ETH side)
  const signalToken = tokenOut === 'USDC' ? tokenIn : tokenOut
  return {
    tokenIn, tokenOut, signalToken,
    amount:     parseDollar(p.amount) ?? 50,
    intervalMs: parseIntervalMs(p.interval) ?? 6 * 36e5,
    minDrop:    parsePct(p.min_drop ?? p.min_rise) ?? 2,
    emaPeriod:  parseInt(p.ema_period ?? '20', 10),
    // selling = WETH→USDC on rally; buying = USDC→WETH on dip
    selling:    tokenOut === 'USDC',
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
      // Sell signal: price above EMA by minDrop% (minDrop reused as minRise)
      if (pctAbove >= minDrop) {
        const wethBal = bal.eth
        // Use exactOutput: receive exactly `amount` USDC by selling however much WETH needed
        const maxWethToSpend = wethBal * MAX_POSITION_PCT
        if (maxWethToSpend <= 0) { log(`[MomentumDCA] insufficient WETH to sell`); return }
        log(`[MomentumDCA] ✅ rally signal: ${pctAbove.toFixed(2)}% above EMA — selling WETH to receive $${amount} USDC`)
        const r = await queueSwap({ token_in: signalToken, token_out: 'USDC', amount_out: String(amount) })
        log(`[MomentumDCA] ✓ ${r.status} tx=${r.txHash?.slice(0, 10)}...`)
      } else {
        log(`[MomentumDCA] waiting — need ${minDrop}% rally above EMA, currently ${pctAbove >= 0 ? pctAbove.toFixed(2) + '% above' : pctBelow.toFixed(2) + '% below'}`)
      }
    } else {
      // Buy signal: price below EMA by minDrop%
      if (pctBelow >= minDrop) {
        const safeAmt = safeUsdc(amount, bal.usdc, 'MomentumDCA', log)
        if (!safeAmt) return
        log(`[MomentumDCA] ✅ dip signal: ${pctBelow.toFixed(2)}% below EMA — buying $${safeAmt} → ${tokenOut}`)
        const r = await queueSwap({ token_in: 'USDC', token_out: tokenOut, amount_in: safeAmt })
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
      const safeAmt = safeUsdc(amountPerGrid, bal.usdc, 'Grid', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'RSIReversal', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'MACross', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'BBBounce', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'MACDCross', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'RSIBBDual', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'TrendFollow', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'Breakout', log)
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
      const safeAmt = safeUsdc(amount, bal.usdc, 'CategoryRotate', log)
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
      const safeAmt = safeUsdc(amountEach, bal.usdc, 'TopNVolume', log)
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
    const safeAmt = safeUsdc(buyUsd, bal.usdc, 'AccumulateDip', log)
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

const PLAN_SYSTEM = `You are a trading strategy compiler. Convert natural language trading strategies into a JSON execution plan.

Output ONLY valid JSON — no explanation, no markdown, no code fences. Schema:

{
  "tasks": [
    {
      "id": "short_unique_id",
      "description": "human readable summary",
      "interval": "1m",
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
- Swappable tokens (Base mainnet, Uniswap V3):
    Stablecoins: USDC, USDBC, USDT, DAI
    ETH/wrapped: ETH, WETH, CBETH
    BTC:         CBBTC
    DeFi:        LINK, AAVE, UNI, RETH
  ETH and WETH are interchangeable (ETH auto-wraps to WETH before swapping).
  USDT maps to USDC (same underlying on Base).
  Non-hub pairs (e.g. LINK→CBBTC) are automatically routed through WETH.
- token_in/token_out MUST be one of the swappable tokens listed above — use their exact symbol
- Tokens NOT available for swapping (price signals only): BTC, SOL, ARB, OP, MATIC, ATOM, etc.
- amount_in = spend this exact amount; amount_out = receive this exact amount (use one, not both)
- "buy ETH/WETH with USDC/USDT" = token_in:USDC, token_out:WETH
- "buy USDC/USDT from ETH/WETH" = token_in:WETH, token_out:USDC

DOLLAR AMOUNTS — critical rules (most common source of mistakes):

Stablecoins: USDC, USDT, DAI, USDBC — already priced in dollars, use amount_in/amount_out directly.
Non-stablecoins: ETH, WETH, LINK, AAVE, UNI, COMP, CBBTC, RETH, CBETH, and ALL others — prices fluctuate.
  → NEVER hardcode a token amount for a non-stablecoin when the user expressed a dollar value ($X).
  → ALWAYS use usd_amount_in or usd_amount_out so the agent fetches the live price at each trade execution.

The agent resolves at trade time: usd_amount_in → amount_in = $X / live_price(token_in)
                                  usd_amount_out → amount_out = $X / live_price(token_out)

Decision table — look at which side is a stablecoin:

  token_in=STABLE,  token_out=anything → amount_in:"X"       (e.g. USDC→LINK: amount_in:"1")
  token_in=NONSTABLE, token_out=STABLE → amount_out:"X"      (e.g. ETH→USDC: amount_out:"1")
  token_in=NONSTABLE, token_out=NONSTABLE, spend $X → usd_amount_in:"X"   (e.g. ETH→LINK, AAVE→UNI)
  token_in=NONSTABLE, token_out=NONSTABLE, receive $X → usd_amount_out:"X" (e.g. LINK→ETH receive $1)

Examples:
- "$1 worth of ETH from USDC"  → token_in:"USDC",  token_out:"WETH", amount_in:"1"
- "$1 worth of LINK from USDC" → token_in:"USDC",  token_out:"LINK", amount_in:"1"
- "$1 worth of USDC from ETH"  → token_in:"WETH",  token_out:"USDC", amount_out:"1"
- "$1 worth of LINK from ETH"  → token_in:"WETH",  token_out:"LINK", usd_amount_in:"1"
- "$1 worth of UNI from ETH"   → token_in:"WETH",  token_out:"UNI",  usd_amount_in:"1"
- "$1 worth of AAVE from LINK" → token_in:"LINK",  token_out:"AAVE", usd_amount_in:"1"
- "$1 worth of ETH from LINK"  → token_in:"LINK",  token_out:"WETH", usd_amount_in:"1"
- "0.001 ETH" (bare amount, no $) = exact token amount → amount_out:"0.001"
- For unconditional tasks, omit the "condition" field
- For conditional tasks, include one condition object
- Condition token can be any supported indicator token (not just swappable ones)

Condition types:
- price_above_ema: { type, token, ema ("ema_9"|"ema_12"|"ema_20"|"ema_26"|"ema_50"), pct (number, % above EMA, 0=any amount above) }
- price_below_ema: { type, token, ema, pct (number, % below EMA) }
- rsi_above: { type, token, level (number 0-100, e.g. 70 for overbought) }
- rsi_below: { type, token, level (number 0-100, e.g. 30 for oversold) }
- price_above: { type, token, price (absolute USD price threshold) }
- price_below: { type, token, price (absolute USD price threshold) }
- macd_bullish: { type, token } — MACD line above signal line (bullish crossover)
- macd_bearish: { type, token } — MACD line below signal line (bearish crossover)
- bb_below_lower: { type, token } — price at or below lower Bollinger Band (oversold)
- bb_above_upper: { type, token } — price at or above upper Bollinger Band (overbought)
- adx_above: { type, token, level } — strong trend (ADX > level, typical: 25)
- change_24h_above: { type, token, pct } — 24h price change above pct% (e.g. 0.001 = 0.001%)
- change_24h_below: { type, token, pct } — 24h price change below pct%
- and: { type: "and", conditions: [...] } — ALL conditions must be true
- or: { type: "or", conditions: [...] } — ANY condition must be true

Available tokens for conditions/indicators (price data):
ETH, WETH, BTC, WBTC, SOL, AVAX, BNB, DOT, USDC, USDT, DAI, FRAX,
ARB, OP, MATIC, POL, LINK, UNI, AAVE, CRV, MKR, SNX, COMP, LDO, RPL, ENS,
CBETH, RETH, ATOM, NEAR, APT, SUI

Available fields from get_indicators: price_usd, ema_9, ema_12, ema_20, ema_26, ema_50, rsi, macd, macd_signal, bb_upper, bb_lower, bb_middle, adx, atr_pct, change_24h`

// Plan cache — keyed on strategy text, cleared on restart
let planCache = { text: '', tasks: [] }

async function compilePlan(strategyText, log) {
  if (planCache.text === strategyText) return planCache.tasks

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
          anthropic_version: 'vertex-2023-10-16', max_tokens: 512,
          system: PLAN_SYSTEM,
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
          model: 'claude-haiku-4-5-20251001', max_tokens: 512,
          system: PLAN_SYSTEM,
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
          model, max_tokens: 512,
          messages: [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: strategyText }],
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
  planCache = { text: strategyText, tasks }
  log(`📋 plan compiled: ${tasks.length} task(s) — ${tasks.map(t => `${t.id}(${t.interval})`).join(', ')}`)
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
    default:
      console.log(`[Condition] unknown type: ${cond.type}`)
      return false
  }
}

// ── Task runner ────────────────────────────────────────────────────────────

async function runTask(task, log) {
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
    if (STABLECOINS.has(sym)) return usdAmt  // 1 USDC = $1, no conversion needed
    try {
      const priceData = await callTool('get_price', { token })
      const price = priceData?.price_usd
      if (!price || price <= 0) throw new Error(`no price for ${token}`)
      const resolved = (parseFloat(usdAmt) / price).toFixed(8)
      log(`[${task.id}] 💱 $${usdAmt} ÷ $${price.toFixed(2)} = ${resolved} ${token} (${label})`)
      return resolved
    } catch (e) {
      log(`[${task.id}] ⚠ price fetch failed for ${token}: ${e.message} — skipping trade`)
      return null
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
    log(`[${task.id}] ❌ swap failed: ${e.message}`)
  }
}

// ── Apply strategy (called on every stream update) ────────────────────────

let currentPortfolio = null

async function applyStrategy(strategyText, log) {
  for (const t of activeTimers) clearInterval(t)
  activeTimers = []
  indicatorFetchCache.clear()

  if (!strategyText?.trim()) {
    log('📭 no strategy — agent idle')
    return
  }

  // @Skill directives → deterministic skill engine (no LLM, no change)
  const skills = parseStrategy(strategyText)
  if (skills.length) {
    log(`📋 skill mode: ${skills.length} skill(s) — [${skills.map(s => s.name).join(', ')}]`)
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
    return
  }

  // Natural language → compile plan once, run deterministically
  if (!AI_API_KEY) {
    log('⚠ AI_API_KEY not set — use @SkillName directives or set AI_API_KEY')
    return
  }

  let tasks
  try {
    tasks = await compilePlan(strategyText, log)
  } catch (e) {
    log(`⚠ ${e.message}`)
    return
  }

  if (!tasks.length) {
    log('⚠ plan has no tasks — agent idle')
    return
  }

  // Group tasks by interval and schedule each group
  const byInterval = new Map()
  for (const task of tasks) {
    const ms = parseIntervalMs(task.interval) ?? 5 * 60_000
    if (!byInterval.has(ms)) byInterval.set(ms, [])
    byInterval.get(ms).push(task)
  }

  const ivLabel = ms => ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`

  for (const [ms, intervalTasks] of byInterval) {
    log(`⏰ scheduling ${intervalTasks.length} task(s) every ${ivLabel(ms)}`)
    const tick = () => {
      indicatorFetchCache.clear() // fresh indicators each tick
      for (const task of intervalTasks) {
        runTask(task, log).catch(e => log(`[${task.id}] error: ${e.message}`))
      }
    }
    tick() // first tick immediately
    activeTimers.push(setInterval(tick, ms))
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

  // Load AI config from MCP server (set by user in terminal setup page)
  log('loading agent config...')
  const cfg = await loadAgentConfig()
  AI_API_KEY        = cfg.AI_API_KEY
  VERTEX_PROJECT_ID = cfg.VERTEX_PROJECT_ID
  VERTEX_SA_JSON    = cfg.VERTEX_SA_JSON
  AI_PROVIDER       = cfg.AI_PROVIDER
  log(`ai provider: ${AI_PROVIDER}`)

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
    log(`portfolio: ${currentPortfolio.eth} ETH ($${currentPortfolio.eth_usd}) + ${parseFloat(currentPortfolio.usdc).toFixed(2)} USDC = $${currentPortfolio.total_usd} total`)
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
