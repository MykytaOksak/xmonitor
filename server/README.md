# XARB server

Hosts the website (the Vite build plus the `/px` proxies its quote engine
calls), and runs that same engine around the clock to check price alerts and
deliver them through your Telegram bot. Site, proxies and bot share one host:
https://xarb-bot.fly.dev. The old Vercel address redirects there.

The bot also lets you manage alerts:

| Command | What it does |
|---|---|
| `/alerts` | Every pair with its state (🔔 on · 🔕 paused · ▫️ not set). Tap one to switch BUY/SELL on or off, change targets, flip above/below, or pause the whole pair. |
| `/history` | Recent notifications (`/history 40` for more). |
| `/status` | Uptime, last price check, and which networks are failing for each watched pair. |

Alert messages carry **⏸ Pause pair** and **⚙️ Pair** buttons. Targets are
typed as replies: `0.9985`, `above 1.001`, `below 0.999 cooldown 20`.

The website shares the same settings: alerts, sizes, network toggles and custom
pairs. Link it once under **Alerts → Telegram bot** with the server's
`ADMIN_TOKEN`. Edits in either place show up in the other within about 20 seconds.

Only pairs with an active alert are quoted, so an idle server barely uses the
quote APIs.

## Run locally

```bash
npm run server
```

Reads `.env.local` (see `.env.example`). While the hosted bot is live, run local
copies with `TG_POLL=0`. Telegram allows only one process to poll a bot. To
point a local website at a local server, add `BOT_URL=http://localhost:8080` to
`.env.local` and restart `npm run dev`.

## Deploy to Fly.io

One-time setup, from the project root:

```bash
brew install flyctl
fly auth login
fly apps create xarb-bot            # if the name is taken, pick another and change
                                    # `app` in fly.toml, the bot URL in upstreams.json
                                    # and the redirect in vercel.json
fly volumes create xarb_data --region fra --size 1 --yes
```

Secrets. Keep a copy of `ADMIN_TOKEN`: the website asks for it.

```bash
fly secrets set TG_BOT_TOKEN=<from @BotFather> ADMIN_TOKEN=$(openssl rand -hex 32) ENSO_KEY=<enso key> ETHERSCAN_KEY=<etherscan key>
fly secrets list                    # values stay hidden; to read ADMIN_TOKEN back: fly ssh console -C 'printenv ADMIN_TOKEN'
```

Deploy (and after every change to the site or the server — pushing to GitHub
does not deploy it):

```bash
fly deploy --ha=false               # exactly one machine
```

Then link your chat. Message the bot: it replies with your chat id. Then run:

```bash
fly secrets set TG_OWNER_CHAT_ID=<that id>
```

Setting a secret restarts the machine. From then on the bot answers only you.

Logs: `fly logs`. Cost: a 512 MB shared machine plus a 1 GB volume, roughly
$3–4 a month.
