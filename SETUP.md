# Riddle Buy Bot — Setup

Start to finish. Testnet first, mainnet last.

---

## 0. What you need

- A machine that stays on — VPS (~£5/mo Hetzner or DigitalOcean), or your own box
- **Node.js 20 or newer** — check with `node -v`
- A Telegram account

Install Node if you haven't:

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential

# macOS
brew install node
```

`build-essential` matters — `better-sqlite3` compiles a native module and the
install fails without a C++ toolchain.

---

## 1. Create the bot on Telegram

Open Telegram, message **@BotFather**:

1. `/newbot`
2. Name it: `Riddle Bot`
3. Username: must end in `bot`, e.g. `RiddleLabsBot`
4. **Copy the token it gives you** — looks like `7xxxxxxxxx:AAF...`. This is the
   password to your bot. Anyone with it controls it.

Then set the rest:

```
/setdescription   Buy and sell every XRPL token and NFT from Telegram. By Riddle Labs.
/setabouttext     XRPL trading bot — tokens, NFTs, live pricing. riddlelabs.io
/setuserpic       (upload assets/rdl-avatar-512.png)
```

---

## 2. Install

```bash
unzip riddle-bot.zip
cd xrpl-buy-bot
npm install
```

Expect a minute or two — `xrpl` and `better-sqlite3` are chunky.

---

## 3. Configure

```bash
cp .env.example .env
npm run keygen
```

`keygen` prints a 64-character hex string. Open `.env` and fill in:

```ini
BOT_TOKEN=7xxxxxxxxx:AAF...        # from BotFather
MASTER_KEY=<the keygen output>     # back this up somewhere safe
```

Leave everything else alone for now — it's already pointed at **testnet**.

> **MASTER_KEY encrypts every user's wallet seed.** Lose it and every wallet in
> the database is unrecoverable. Change it later and the same thing happens.
> Back it up before you go any further, somewhere that isn't the server.

---

## 4. Run it on testnet

```bash
npm start
```

You should see:

```
Connected to XRPL: wss://s.altnet.rippletest.net:51233 (testnet)
Riddle Bot running — part of Riddle Labs.
```

Now open your bot in Telegram and hit **Start**.

### Fund a test wallet

1. In the bot: **Wallet → Create new wallet**
2. Copy the address it shows you
3. Go to https://xrpl.org/xrp-testnet-faucet.html, paste the address, click the
   button — you get 100 fake XRP

### Test every flow before you touch real money

- [ ] **Trending** — list loads
- [ ] Tap a token — price card renders
- [ ] **Buy 5 XRP** — trustline opens, fill confirms, explorer link works
- [ ] **Portfolio** — position shows with a value
- [ ] **Sell 50%** — XRP comes back
- [ ] **NFTs → Top collections** — loads (thin on testnet, that's normal)
- [ ] **Wallet → Withdraw** — send 1 XRP to another address
- [ ] **Settings** — change slippage, toggle auto-trustline
- [ ] **Alerts** — set one, confirm it fires
- [ ] `/history` — trades are logged
Anything fails, fix it here. Bugs on testnet cost nothing.

---

## 5. Go to mainnet

Only after step 4 is fully green. In `.env`:

```ini
XRPL_WS_URL=wss://xrplcluster.com
XRPL_NETWORK=mainnet
```

Set your revenue wallet while you're in there:

```ini
FEE_WALLET=rYourRealXRPLAddress
FEE_BPS=100          # 100 = 1% of filled volume
```

Restart. **Then test with 5 XRP of your own money before telling anyone about it.**

---

## 6. Keep it running

`npm start` dies when you close the terminal. Use pm2:

```bash
npm install -g pm2
pm2 start src/index.js --name riddle-bot
pm2 save
pm2 startup          # run the command it prints — survives reboots
```

Useful:

```bash
pm2 logs riddle-bot        # live logs
pm2 restart riddle-bot     # after changing .env
pm2 stop riddle-bot
pm2 monit                  # cpu / memory
```

### Back up the database

`data/bot.db` holds every user's encrypted seed. Losing it loses their money.

```bash
crontab -e
# nightly at 3am
0 3 * * * cp /path/to/xrpl-buy-bot/data/bot.db /path/to/backups/bot-$(date +\%F).db
```

Store `MASTER_KEY` somewhere *different* from the backups. Together they're the
funds; separately, neither is.

---

## Configuration reference

| Variable | Default | What it does |
|---|---|---|
| `BOT_TOKEN` | — | From @BotFather. Required. |
| `MASTER_KEY` | — | 32-byte hex. Encrypts seeds. Required. |
| `XRPL_WS_URL` | testnet | Which ledger to trade on |
| `XRPLTO_API_KEY` | none | Free tier is 10 req/sec; a key raises it |
| `DEFAULT_SLIPPAGE_BPS` | 300 | 3%. Users can override per account |
| `QUICK_BUY_XRP` | 5,10,25,100 | The one-tap buy buttons |
| `RESERVE_BUFFER_XRP` | 2 | XRP held back so accounts stay alive |
| `FEE_BPS` | 100 | Your cut. 100 = 1% |
| `FEE_WALLET` | none | Where the cut goes. Blank = no fee charged |
| `BRAND_SITE` | riddlelabs.io | Link button on the main menu |
| `ADMIN_IDS` | none | Comma-separated Telegram user IDs |

Get your Telegram ID from **@userinfobot** if you want to set `ADMIN_IDS`.

---

## Troubleshooting

**`better-sqlite3` fails to install**
Missing build tools. `sudo apt install build-essential python3` then
`npm install` again.

**`Missing required env var: BOT_TOKEN`**
No `.env` file, or you're running from the wrong directory. `.env` sits next to
`package.json`.

**Bot starts but doesn't reply**
Another copy is already running — Telegram only allows one poller per token.
`pm2 delete all` and start once.

**`Not enough liquidity on the order book`**
Real. That token has a thin book at your size. Try smaller.

**`Price moved past your slippage`**
Raise slippage in Settings, or trade smaller. On volatile new tokens 5–10% is
normal.

**`tecPATH_DRY`**
No route between XRP and that token right now. Usually a dead or brand-new
token.

**Buys fail with insufficient funds despite a balance**
XRPL reserves. Base reserve plus 0.2 XRP per trustline is locked and unusable.
`RESERVE_BUFFER_XRP` exists for exactly this.

---

## Before you let other people use it

You'd be holding their private keys. That's a custodial service, with the legal
weight that carries — not a hobby project.

Minimum before anyone else's money is involved:

- `MASTER_KEY` in a secrets manager, not a file next to `bot.db`
- Full-disk encryption on the server
- Per-user rate limiting — nothing currently stops a buy loop
- A daily spend cap per account
- Terms of service, and a clear statement that you hold the keys

**The cleaner path:** swap the signing layer for Xaman deep links, like you did
on Riddle Scanner and Riddle Swap. Users sign in their own wallet, you never
touch a seed, and most of the list above stops being your problem. It's roughly
a day's work against `src/services/wallet.js` and the two `submit()` call sites.
Worth deciding before the first real deposit, not after.
