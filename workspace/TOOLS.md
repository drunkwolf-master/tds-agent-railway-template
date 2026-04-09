# TDS MCP Tools Reference

These tools are available via the TDS MCP server. Use them to manage wallets, execute trades, and fetch market data on Uniswap V3 (Base Sepolia).

## Wallet Tools

### wallet_create
Create a new wallet for this agent. Only call once on first startup.
```
wallet_create()
→ { address: "0x...", created_at: "..." }
```

### wallet_get
Get the current wallet address.
```
wallet_get()
→ { address: "0x..." }
```

### get_balance
Get ETH and token balances.
```
get_balance()
→ { address: "0x...", eth: "0.42", usdc: "250.00", network: "base-sepolia" }
```

### fund_wallet
Get the deposit address to fund the wallet.
```
fund_wallet()
→ { deposit_address: "0x...", network: "Base Sepolia" }
```

### withdraw
Send funds from the agent wallet to an external address.
```
withdraw(to_address: "0x...", amount: "0.1", asset: "ETH")
→ { status: "confirmed", txHash: "0x...", to: "0x...", amount: "0.1" }
```

### get_portfolio
Get full portfolio snapshot with USD values and current ETH price.
```
get_portfolio()
→ {
    address: "0x...",
    eth: "0.42",         // ETH balance
    usdc: "250.00",      // USDC balance
    eth_usd: "1344.00",  // ETH value in USD
    usdc_usd: "250.00",  // USDC value in USD
    total_usd: "1594.00",
    eth_price: 3200.50,
    network: "base-sepolia"
  }
```
**Use this before every trade** to check available capital and current allocation.

## Trading Tools

### execute_swap
Execute a token swap on Uniswap V3 (Base Sepolia).
```
execute_swap(
  token_in: "USDC",
  token_out: "WETH",
  amount_in: "50",       // or amount_out for exactOutput
  max_slippage: 50       // basis points, optional (default: 50 = 0.5%)
)
→ { txHash: "0x...", amountIn: "50", tokenIn: "USDC", tokenOut: "WETH", status: "confirmed" }
```

**Supported tokens on Base Sepolia: `USDC` and `WETH` (ETH) only.**
All strategy swaps must use one of these two tokens. `get_price` and `get_indicators` can fetch data for any token (BTC, SOL, etc.) for signal computation, but swaps only execute for USDC ↔ WETH.

Use `amount_in` for exactInput (spend exact amount). Use `amount_out` for exactOutput (receive exact amount).

### get_trade_history
Get past trades for this wallet.
```
get_trade_history(limit: 50)
→ { trades: [{ id, txHash, tokenIn, tokenOut, amountIn, amountOut, status, executedAt }], count: N }
```
**Use on restart** to check whether you are already in a position before placing a new entry.

## Market Data Tools

### get_price
Get the current USD price, 24h/7d change, and volume for any token.
```
get_price(token: "ETH")
→ {
    symbol: "ETH",
    price_usd: 3200.50,
    change_24h: 2.45,    // % change
    change_7d: -1.20,
    volume_24h: 12000000000
  }
```

### get_indicators
Get a full professional-grade indicator suite for any token. Calculated from 90-day 4h OHLCV data via CoinGecko using Wilder's smoothing (matches TradingView).
```
get_indicators(token: "ETH")
→ {
    // Price
    symbol: "ETH",
    price_usd: 3200.50,
    change_24h: 2.45,
    volume_24h: 12000000000,

    // EMAs
    ema_9:  3180.00,    // 9-period EMA
    ema_12: 3150.20,    // 12-period EMA  ← use for MA crossover fast line
    ema_20: 3120.00,    // 20-period EMA  ← use for MomentumDCA, TrendFollow
    ema_26: 3080.40,    // 26-period EMA  ← use for MA crossover slow line
    ema_50: 2950.00,    // 50-period EMA  ← use for long-term trend

    // Oscillators
    rsi: 52.3,          // RSI-14, Wilder's smoothing (0-100)
    stoch_k: 68.2,      // StochRSI %K
    stoch_d: 64.5,      // StochRSI %D

    // Bollinger Bands (20-period, 2 std devs)
    bb_upper:  3450.00,
    bb_middle: 3200.00, // 20-period SMA
    bb_lower:  2950.00,
    bb_width:  0.156,   // (upper-lower)/middle — measures volatility
    bb_pct_b:  0.50,    // 0 = at lower band, 0.5 = middle, 1 = at upper band

    // MACD (12/26/9)
    macd_line:        35.20,
    macd_signal:      28.40,
    macd_histogram:   6.80,
    prev_macd_line:   30.10, // previous period — use for crossover detection
    prev_macd_signal: 29.20,
    prev_histogram:   1.00,

    // Trend Strength (ADX + Directional Indicators)
    adx:      28.5,     // ADX-14: > 25 = strong trend, < 20 = ranging
    di_plus:  32.1,     // +DI: upward directional strength
    di_minus: 18.4,     // -DI: downward directional strength

    // Volatility
    atr:     85.20,     // ATR-14 in price units
    atr_pct: 2.66,      // ATR as % of price

    // Price context
    recent_high_14d: 3600.00,
    recent_low_14d:  2800.00,
    recent_high_30d: 3800.00,
    recent_low_30d:  2600.00
  }
```

### get_market_leaders
Get top tokens ranked by volume, gainers, losers, or market cap.
```
get_market_leaders(limit: 20, sort: "volume")
// sort options: "volume" | "gainers" | "losers" | "market_cap"
→ {
    tokens: [
      { symbol: "BTC", name: "Bitcoin", price_usd: 65000, change_24h: 1.2, volume_24h: 28000000000, market_cap: 1200000000000, rank: 1 },
      ...
    ]
  }
```
**Note:** This returns price/volume data for any token. On Base Sepolia, only WETH/USDC are swappable. Use this tool for signal and ranking only — filter to WETH before executing any swap.

## Indicator Quick Reference

| Indicator | Key values | Interpretation |
|---|---|---|
| **RSI** | < 30 oversold / > 70 overbought | Mean reversion signal |
| **ema_12 vs ema_26** | ema_12 > ema_26 = uptrend | Golden/Death Cross (use `@MACross`) |
| **ema_20** | Price vs ema_20 | Short-term trend filter (`@MomentumDCA`) |
| **ema_50** | Price vs ema_50 | Long-term trend filter (`@TrendFollow`) |
| **BB %B** | 0 = lower band / 1 = upper band | Position within Bollinger Bands |
| **MACD histogram** | > 0 and rising = bullish | Momentum direction |
| **ADX** | > 25 strong / < 20 ranging | Trend strength (not direction) |
| **di_plus vs di_minus** | di_plus > di_minus = up pressure | Trend direction confirmation |
| **ATR %** | Higher = more volatile | Stop-loss sizing |
| **recent_high_14d** | Resistance level | Breakout confirmation |
