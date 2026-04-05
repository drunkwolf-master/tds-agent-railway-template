/**
 * Mock MCP client for skill testing.
 * Records all callTool calls and returns realistic fixture data.
 * Swap between this and real mcp-client.mjs via RENAME before running agent in test mode.
 */

export const calls = []  // all recorded { tool, args } in order

const INDICATORS = {
  price_usd:       2000,
  ema_9:           1950,
  ema_12:          1900,
  ema_20:          1850,
  ema_26:          1800,
  ema_50:          1700,
  rsi:             35,           // oversold → triggers RSI buy
  stoch_k:         20,
  stoch_d:         18,
  bb_upper:        2200,
  bb_middle:       2000,
  bb_lower:        1800,
  bb_width:        20,
  bb_pct_b:        0.1,          // near lower band → triggers BB buy
  macd_line:       50,
  macd_signal:     30,
  macd_histogram:  20,
  prev_macd_line:  20,
  prev_macd_signal:30,           // crossed above → bullish
  prev_histogram: -10,
  adx:             28,
  di_plus:         25,
  di_minus:        15,
  atr:             50,
  atr_pct:         2.5,
  recent_high_14d: 2100,
  recent_low_14d:  1900,
  recent_high_30d: 2200,
  recent_low_30d:  1700,
  change_24h:      2.0,
  change_7d:       5.0,
}

const PORTFOLIO = {
  address:   '0xTEST',
  eth:       '0.010',           // > GAS_BUFFER (0.001) → ok: true
  usdc:      '200',
  eth_usd:   '20.00',
  usdc_usd:  '200.00',
  total_usd: '220.00',
  eth_price: 2000,
  network:   'base-sepolia',
}

const SWAP_RESULT = {
  status:   'confirmed',
  txHash:   '0xdeadbeef1234567890abcdef',
  tokenIn:  'USDC',
  tokenOut: 'WETH',
  amountIn: '50',
  network:  'base-sepolia',
}

const MARKET_LEADERS = {
  tokens: [
    { symbol: 'WETH',  price_usd: 2000, change_24h: 2.0, volume_24h: 1e9, market_cap: 5e11, rank: 1 },
    { symbol: 'USDC',  price_usd: 1,    change_24h: 0.0, volume_24h: 5e8, market_cap: 5e10, rank: 2 },
  ],
}

export async function callTool(tool, args = {}) {
  calls.push({ tool, args: JSON.parse(JSON.stringify(args)) })

  switch (tool) {
    case 'get_portfolio':      return PORTFOLIO
    case 'get_balance':        return { eth: PORTFOLIO.eth, usdc: PORTFOLIO.usdc }
    case 'wallet_get':         return { address: '0xTEST' }
    case 'wallet_create':      return { address: '0xTEST', created_at: new Date().toISOString() }
    case 'get_price':          return { price_usd: INDICATORS.price_usd, change_24h: INDICATORS.change_24h }
    case 'get_indicators':     return { ...INDICATORS }
    case 'get_market_leaders': return MARKET_LEADERS
    case 'get_trade_history':  return { trades: [], count: 0 }
    case 'execute_swap':       return { ...SWAP_RESULT, tokenIn: args.token_in, tokenOut: args.token_out }
    default:
      throw new Error(`Mock: unknown tool "${tool}"`)
  }
}

export function startHeartbeat() {}  // no-op in tests
