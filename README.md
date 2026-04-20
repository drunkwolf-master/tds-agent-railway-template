# Deploy and Host The Dumb Street on Railway

The Dumb Street (TDS) is an autonomous Uniswap V4 trading agent platform. Sign in with Google, get a self-custody wallet on Base, configure your strategy, and deploy an AI agent that executes trades on-chain autonomously.

## About Hosting The Dumb Street

Hosting TDS means running the OpenClaw agent runtime on Railway. The agent connects to your TDS MCP server, reads your trading strategy, and executes Uniswap V4 swaps on Base autonomously. Railway keeps the agent alive 24/7 and handles restarts. On first boot the agent self-configures with your AI provider, MCP connection, and wallet auth token, then begins executing your strategy on schedule.

## Common Use Cases

- Dollar-cost averaging: Automatically buy ETH or other tokens on a fixed schedule using USDC on Base
- Strategy automation: Run custom trading strategies defined in plain English via The Dumb Street terminal editor
- Autonomous agent deployment: Deploy a self-operating on-chain agent without managing servers or infrastructure

## Dependencies for The Dumb Street Hosting

- TDS MCP Server: The tool server your agent calls to execute trades. Must be publicly reachable via Railway or ngrok
- AI Provider API Key: Anthropic, OpenAI, Gemini, or OpenRouter key to power the agent reasoning

### Deployment Dependencies

- [The The Dumb Street](https://the-dumb-street.vercel.app)
- [OpenClaw agent runtime](https://www.npmjs.com/package/openclaw)
- [Base network](https://base.org)
- [Uniswap V4](https://docs.uniswap.org)

## Why Deploy The Dumb Street on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying The Dumb Street on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
 
  
  
