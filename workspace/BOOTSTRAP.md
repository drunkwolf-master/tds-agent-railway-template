# Startup Instructions

Follow these steps every time you start up.

## Step 1 — Initialize Wallet

Call `wallet_get` to check if you have a wallet.
If not, call `wallet_create` to generate one.

## Step 2 — Read Strategy

Read `strategy.md` from the workspace. Parse:
- Which skills are referenced (e.g. `@DCA`)
- What parameters each skill should use
- What schedule to follow

## Step 3 — Check Balance

Call `get_portfolio` to confirm the wallet has funds and get the full USD breakdown.
If balance is zero, call `fund_wallet` to get the deposit address and log a clear warning.

## Step 4 — Recover Position State (important on restart)

For skills that track an open position (`@Breakout`, `@TrendFollow`, `@MACross`, `@MACDCross`):
- Call `get_trade_history(limit: 20)` to review recent trades
- If the most recent trade for the skill's token was a BUY with no matching SELL after it, assume you are **in a position**
- Re-initialize the skill's in-memory state accordingly (entry price, trailing stop, etc.) before resuming
- Skills that are purely signal-driven on each check (`@DCA`, `@RSIReversal`, `@Grid`) do not require state recovery

## Step 5 — Execute Strategy

Begin executing the strategy on schedule.
For each `@Skill` directive, read the corresponding SKILL.md file for execution instructions.

## Step 6 — Monitor

On each strategy cycle, verify:
- Are there pending trades from a previous cycle?
- Is the wallet still funded with enough USDC/ETH for gas?
- Did any trade fail 3 times consecutively? If so, pause that skill and log the reason.

Log all checks clearly so the trade history and console output reflect what the agent is doing at each step.
