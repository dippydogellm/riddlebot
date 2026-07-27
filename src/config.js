import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  botToken: required('BOT_TOKEN'),

  // 32-byte hex. Encrypts every stored wallet seed. Losing it = losing every wallet.
  masterKey: Buffer.from(required('MASTER_KEY'), 'hex'),

  xrpl: {
    // Public clusters: wss://xrplcluster.com, wss://s1.ripple.com
    // Testnet: wss://s.altnet.rippletest.net:51233
    wsUrl: process.env.XRPL_WS_URL || 'wss://xrplcluster.com',
    network: process.env.XRPL_NETWORK || 'mainnet',
  },

  api: {
    base: process.env.XRPLTO_API_BASE || 'https://api.xrpl.to/v1',
    key: process.env.XRPLTO_API_KEY || null, // optional, raises rate limit
    timeoutMs: 12000,
  },

  trading: {
    defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS || 300), // 3%
    maxSlippageBps: 5000,
    // Quick-buy amounts in XRP shown on the buy keyboard
    quickBuyXrp: (process.env.QUICK_BUY_XRP || '5,10,25,100').split(',').map(Number),
    // Your revenue: taken as a separate XRP payment after a successful fill
    feeBps: Number(process.env.FEE_BPS || 100), // 1%
    feeWallet: process.env.FEE_WALLET || null,
  },

  limits: {
    // XRPL base reserve; keep this much XRP untouchable so accounts stay alive
    reserveBufferXrp: Number(process.env.RESERVE_BUFFER_XRP || 2),
    ownerReserveXrp: 0.2, // per trustline / per NFT offer
  },

  dbPath: process.env.DB_PATH || './data/bot.db',
  admins: (process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(Number),
};
