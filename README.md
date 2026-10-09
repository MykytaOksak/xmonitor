# XARB · Cross-Chain Arbitrage Monitor (hosted)

Термінальний дашборд для моніторингу крос-чейн арбітражу між парами стейбл/LST-токенів.
Реалізація дизайну з handoff-пакета `design_handoff_arb_monitor` — **React + Vite + TypeScript, без бекенду**:
котирування тягнуться напряму з публічних quote-API, всі оверрайди/алерти живуть у `localStorage`,
Telegram-доставка — напряму через Bot API.

## Запуск

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # prod-бандл у dist/ (статичний хостинг)
```

У dev-режимі всі quote-запити йдуть через проксі Vite (`/px/*`, див. [vite.config.ts](vite.config.ts)) —
це обходить CORS. У prod-збірці запити йдуть напряму на реальні origin'и; ендпоінти, що не
віддають CORS-заголовки, показуються як `ERR` у колонці STATUS (дизайн це передбачає).

## Архітектура

| Шар | Файли | Що робить |
|---|---|---|
| Конфіг | [src/config/networks.ts](src/config/networks.ts), [tokens.ts](src/config/tokens.ts), [pairs.ts](src/config/pairs.ts) | Реєстр мереж + роутинг quote-джерел, адреси токенів, матриця 18 пар, арбітражні правила |
| Провайдери | [src/engine/providers.ts](src/engine/providers.ts) | Адаптери Canoe (kyberswap/okx/openocean), KyberSwap, OpenOcean v4, Eisen, Enso, Jupiter Ultra/Lite з fallback-ланцюжком на мережу |
| Двигун | [src/engine/engine.ts](src/engine/engine.ts), [arb.ts](src/engine/arb.ts) | Цикл сканування (інтервал з Settings, конкурентність 4), best buy/sell з правилами, stale-watchdog, оцінка алертів |
| Стан | [src/state/store.ts](src/state/store.ts) | zustand + persist: оверрайди сум, вимкнені мережі, чернетки/збережені алерти, поріг, профіль |
| Telegram | [src/engine/telegram.ts](src/engine/telegram.ts) | getMe → deep link → поллінг getUpdates до `/start` → sendMessage при спрацюванні алерта |
| UI | [src/components/](src/components/) | Quotes / Alerts / Portfolio (disabled) / Settings за дизайн-токенами handoff'а |

Модель ціни: `buy`/`sell` — це **маргінальний курс** (t1 за 1 t0), отриманий з невеликої
проби (100 у $-парах / 0.1 у WETH-парах), а не з усього notional. Так ціна не спотворюється
сліпеджем, коли заганяти весь обсяг у тонкий пул новіших мереж. **Notional впливає лише на
прибуток** (як і каже лейбл «Amount — notional for profit calc»): прибуток = notional × спред.
Спред = `(bestSell − bestBuy) / bestBuy`.

**Гейт валідності:** якщо round-trip однієї мережі неузгоджений (`|sell − buy| / buy > 15%`),
рядок стає ERR («thin/broken liquidity») замість сміттєвого числа — так відсіюються поламані/
порожні пули чи хибні адреси (напр. sUSDe/USDC на Mantle).

## Стан провайдерів (перевірено наживо)

- **KyberSwap** (`/{chain}/api/v1/routes`, GET) — основний робочий шлях для більшості EVM-мереж
  (Ethereum, Arbitrum, Optimism, Base, BNB, Avalanche, Plasma, HyperEVM, Monad). ✅
- **OpenOcean v4** (GET, human amount) — Mantle та fallback для Plasma. ✅
- **Jupiter** Ultra→Lite (GET) — Solana. ✅
- **Eisen** (POST `tokenInAddr/tokenOutAddr/from/amount/maxEdge/maxSplit/…`) — Katana. ✅ адаптер
  робочий; конкретна пара світиться лише за наявності пулу на Katana (напр. AUSD там пулу не має → ERR).
- **Fluent** — sUSDnr/USDnr через **FluxFlow QuoterV2** (`quoteExactInputSingle`, fee 500) по Fluent RPC. ✅
  Волт Nerona (`0x50AE…`) — це stake/unstake-шлях, але його preview-селектори
  (`previewDeposit 0xb8f82b26` / `previewRedemption 0xb4db4be8`) ревертять при звичайному `eth_call`
  на публічному RPC (Fluent — blended EVM/WASM), тому ціна береться з DEX-квотера.
- **Enso** (POST, масиви `tokenIn/tokenOut/amountIn`, без ключа) — для Ink. Адреси USDC/USDG на Ink
  вписані (Circle native / Paxos), тож USDG/USDC на Ink квотиться; GHO на Ink лишається `null`
  (деплой не підтверджено), тому пара GHO/USDC на Ink частково ERR. ✅/⚠️
- **Canoe (icarus.tools)** — POST-тіло сформовано точно за наданою схемою
  (`chain/account/inTokenAddress/outTokenAddress/isExactIn/slippage/inTokenAmount`), але публічний
  хост віддає `404 page not found` для `/market/*` будь-яким методом — імовірно потрібен API-ключ
  або allowlist. Функціонально це не блокує: спрацьовують fallback'и (KyberSwap/OpenOcean). ⚠️
- **Rhea (NEAR)** — не використовується: жодна пара з матриці не живе на NEAR.

## Дефолтний нотіонал

- Усі `$`-пари → **$50 000** за замовчуванням ([src/config/pairs.ts](src/config/pairs.ts)).
- ETH-номіновані пари (wstETH/WETH, weETH/WETH, msETH/WETH) → **15 WETH ≈ $50k** (номінал у WETH;
  50000 WETH перевищило б ліквідність пулів і давало б деградовані квоти). Змінюється per-pair у
  дровері **Pair settings** (оверрайд у localStorage).

## Адреси токенів — що знайдено, що лишилось

Знайдено й вписано ([src/config/tokens.ts](src/config/tokens.ts)) з авторитетних джерел
(Circle docs, Katana docs, OpenOcean/KyberSwap token-lists):
USDC на HyperEVM/Monad/Ink + vbUSDC на Katana; USDT0 на Monad; WETH(vbETH) на Katana, WETH на
Plasma/Monad; wstETH на Katana/Monad; weETH на Katana/Plasma; USDG на Ink; підтверджено
USDe/sUSDe/AUSD на нових мережах.

**USDC на Plasma → USDT0 (через курс Binance).** Plasma USDT-центрична (канонічного USDC немає),
тому пари *…/USDC* на Plasma квотуються проти **USDT0** (`0xb8ce…`), а нотіонал перераховується за
живим курсом **Binance USDC/USDT** (`GET /api/v3/ticker/price?symbol=USDCUSDT`), щоб ціни лишались
у термінах USDC. Логіка — `resolveToken()` у [src/engine/engine.ts](src/engine/engine.ts) +
[src/engine/rates.ts](src/engine/rates.ts). Курс оновлюється раз на скан (кеш 15с).

Лишились `null` (мережа/токен реально відсутні або не знайдено ліквідного деплою — рядок = ERR):
1. **GHO на Ink та Plasma**, **wstETH на Plasma**, **weETH на Monad** — не знайдено в token-list'ах.
3. **savUSD/USDC на Movement** — Move-VM, жоден із під'єднаних агрегаторів її не квотить.
4. **Верифікація**: адреси з `verified: false` — best-effort, **звірте з експлорером** перед довірою
   (неверифікована адреса може дати «сміттєве» котирування з пустого пулу).
5. **Canoe-доступ** — якщо матимете ключ/хост, додайте заголовок у `providers.ts` → `canoe()`.
6. **Логотипи мереж** — зараз кольорові квадрати-монограми; підмініть на реальні SVG у
   `src/components/ui.tsx` → `NetLogo`.

## Telegram-алерти

Без бекенду використовується Bot API напряму: у в'ю **Alerts** вставте токен бота (@BotFather),
натисніть **Connect Telegram** — відкриється deep link `t.me/<bot>?start=<profileId>`, після
`/start` застосунок зловить chat id через `getUpdates` і збереже локально. Токен зберігається
лише у `localStorage` цього браузера. Спрацьовування алертів (above/below, cooldown, скоуп мереж)
оцінюється в браузері після кожного скану; додатково шлеться браузерна нотифікація.

## Стани системи

- SYNCED / SYNCING / STALE (данi старші 2× інтервалу) / ERROR — в хедері + банери з Refresh/Retry.
- Settings → *Simulate snapshot state* — ручний прогін усіх станів (SYNCING запускає реальний рефреш).
- Поріг у Settings фільтрує фід у реальному часі; від'ємні значення дозволені — зручно дивитись
  біля-нульові спреди (реальні спреди після комісій зазвичай від'ємні).
