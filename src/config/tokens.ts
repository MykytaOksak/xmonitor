import type { NetworkId } from './networks';

export interface TokenDeployment {
  /** EVM address or Solana mint. */
  address: string;
  decimals: number;
  /**
   * false = address is a best-effort placeholder that MUST be verified
   * against a block explorer before trusting quotes on that network.
   */
  verified: boolean;
  /**
   * CEX legs only: true when this currency is the instrument's quote side.
   * Custom pairs know their instrument exactly, so they set this instead of
   * leaning on the provider's base/quote heuristic (which cannot tell
   * ETH-USDT from a pair where ETH is itself the quote).
   */
  cexQuote?: boolean;
  /**
   * The address is an ERC-4626 vault that holds the liquidity (X Layer's
   * wrapped xStocks work this way). Quote the vault, then convert amounts by
   * its live convertToAssets() rate so prices stay in the underlying's terms.
   */
  wrappedVault?: boolean;
}

/**
 * Token registry. `null` = deployment exists per the pair/network matrix in
 * the handoff, but the address was not part of the handoff — fill it in to
 * light the network up. Rows with null tokens render as ERR ("no token
 * config") which the design supports.
 */
export type TokenMap = Record<string, Partial<Record<NetworkId, TokenDeployment | null>>>;

const T = (address: string, decimals: number, verified = true): TokenDeployment => ({
  address,
  decimals,
  verified,
});

export const TOKENS: TokenMap = {
  USDC: {
    ethereum: T('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
    arbitrum: T('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
    optimism: T('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
    base: T('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    bnb: T('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18), // BSC USDC is 18 decimals
    avalanche: T('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6),
    avalancheMint: T('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6),
    mantle: T('0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', 6),
    solana: T('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6),
    katana: T('0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', 6), // vbUSDC (Katana docs)
    hyperevm: T('0xb88339CB7199b77E23DB6E890353E22632Ba630f', 6), // Circle native
    monad: T('0x754704Bc059F8C67012fEd69BC8A327a5aafb603', 6), // Circle native
    ink: T('0x2D270e6886d130D724215A266106e6832161EAEd', 6), // Circle native
    // Plasma is USDT-centric — incoming USDC is converted to USDT0, so there
    // is no canonical liquid USDC deployment; Plasma USDC rows show ERR.
    plasma: null,
    xlayer: T('0xb6ceceab302e2e4948951ee7843fc24e92933061', 6),
    // OKX prices every xStock against USDT (see the note on USDG.okxCex).
    okxCex: T('USDT', 6),
    binanceCex: T('USDC', 6),
    hydration: T('21', 6), // Hydration asset id, not an address
  },
  USDT: {
    ethereum: T('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    arbitrum: T('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
    bnb: T('0x55d398326f99059fF775485246999027B3197955', 18),
    avalanche: T('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
    solana: T('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6),
    monad: T('0xe7cd86e13ac4309349f30b3435a9d337750fc82d', 6), // USDT0 on Monad
    // Plasma's canonical stable is USDT0; used as the USDC proxy on Plasma
    // (see the substitution in engine.ts), amounts scaled by the Binance rate.
    plasma: T('0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', 6, false),
    // Ink is USDT0-centric too: its USDC has no real DEX liquidity (the
    // USDC/USDG pool holds cents), so USDT0 is the USDC proxy there as well.
    ink: T('0x0200c29006150606b650577bbe7b6248f58470c1', 6),
    // X Layer's USDG market runs against USD₮0, not the bridged Tether USD
    // (which has no USDG pool at all). Used as the USDC proxy for USDG/USDC
    // only — see the substitution in engine.ts.
    xlayer: T('0x779Ded0c9e1022225f8E0630b35a9b54bE713736', 6),
    binanceCex: T('USDT', 6),
    // Bybit's USDe market is against USDT; the USDC leg is substituted for it
    // and converted at the live rate (see the substitution in engine.ts).
    bybitCex: T('USDT', 6),
  },
  WETH: {
    ethereum: T('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18),
    optimism: T('0x4200000000000000000000000000000000000006', 18),
    base: T('0x4200000000000000000000000000000000000006', 18),
    katana: T('0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', 18), // vbETH (Katana docs)
    plasma: T('0x9895d81bb462a195b4922ed7de0e3acd007c32cb', 18),
    monad: T('0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242', 18),
  },
  USDe: {
    ethereum: T('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 18),
    // Ethena OFT shares this address; confirmed on Plasma via OpenOcean list.
    mantle: T('0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', 18, false),
    hyperevm: T('0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', 18, false),
    plasma: T('0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', 18),
    monad: T('0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', 18), // Ethena OFT, same address
    solana: T('DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 9, false),
    bybitCex: T('USDE', 8), // exchange currency code, not an address
  },
  sUSDe: {
    ethereum: T('0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', 18),
    arbitrum: T('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', 18, false),
    mantle: T('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', 18, false),
    hyperevm: T('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', 18, false),
    plasma: T('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', 18), // OpenOcean-confirmed
    monad: T('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', 18), // Ethena OFT, same address
  },
  wstETH: {
    ethereum: T('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 18),
    katana: T('0x7Fb4D0f51544F24F385a421Db6e7D4fC71Ad8e5C', 18), // Katana docs
    monad: T('0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417', 18), // KyberSwap list
    plasma: T('0x10Aeaf63194db8d453d4D85a06E5eFE1dd0b5417', 18), // OFT, same as Monad
  },
  weETH: {
    ethereum: T('0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', 18),
    katana: T('0x9893989433e7a383Cb313953e4c2365107dc19a7', 18), // Katana docs
    plasma: T('0xa3d68b74bf0528fdd07263c60d6488749044914b', 18), // KyberSwap list
    monad: T('0xA3D68b74bf0528fdd07263c60d6488749044914b', 18), // OFT, same as Plasma
  },
  GHO: {
    ethereum: T('0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', 18),
    arbitrum: T('0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33', 18),
    base: T('0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee', 18, false),
    ink: T('0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73', 18),
    monad: T('0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73', 18), // same OFT address as Ink
    plasma: T('0xb77e872a68c62cfc0dfb02c067ecc3da23b4bbf3', 18),
  },
  AUSD: {
    // Agora AUSD deploys at the same vanity address on most chains;
    // Katana + Monad confirmed via docs / OpenOcean list.
    ethereum: T('0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', 6),
    avalanche: T('0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', 6),
    katana: T('0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', 6),
    monad: T('0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', 6),
  },
  USD1: {
    ethereum: T('0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', 18),
    bnb: T('0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', 18),
    solana: T('USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', 6, false),
    binanceCex: T('USD1', 6),
  },
  USDG: {
    // Verified on-chain: symbol USDG, name "Global Dollar", 6 dp.
    arbitrum: T('0x004b506865409877c9fa29bfb1eba929984b9bbc', 6),
    // Paxos deploys USDG at the same address on Ethereum and Ink.
    ethereum: T('0xe343167631d89B6Ffc58B88d6b7fB0228795491D', 6),
    ink: T('0xe343167631d89B6Ffc58B88d6b7fB0228795491D', 6), // verified on-chain via the Ink pool
    solana: T('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', 6), // Global Dollar, verified on-chain
    xlayer: T('0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', 6),
    // OKX prices XSPY against USDT; on the CEX the "address" is the OKX
    // currency code, not an on-chain address.
    okxCex: T('USDT', 6),
  },
  sUSDnr: {
    fluent: T('0xFa9b3B45587f9fcdE14759121C3868C2733DCbf4', 6),
    fluentStake: T('0xFa9b3B45587f9fcdE14759121C3868C2733DCbf4', 6),
  },
  USDnr: {
    fluent: T('0xD48e565561416dE59DA1050ED70b8d75e8eF28f9', 6),
    fluentStake: T('0xD48e565561416dE59DA1050ED70b8d75e8eF28f9', 6),
  },
  sUSDAI: {
    ethereum: T('0x0b2b2b2076d95dda7817e785989fe353fe955ef9', 18),
    arbitrum: T('0x0b2b2b2076d95dda7817e785989fe353fe955ef9', 18),
    base: T('0x0B2b2B2076d95dda7817e785989fE353fe955ef9', 18),
    plasma: T('0x0b2b2b2076d95dda7817e785989fe353fe955ef9', 18),
    // Token-2022 mint "Staked USDai", 6 dp (unlike the 18 dp EVM deployments).
    // No scaled-UI-amount extension, so Jupiter's raw amounts need no rescaling.
    solana: T('sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE', 6),
  },
  THBILL: {
    arbitrum: T('0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a', 6),
    hyperevm: T('0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a', 6),
  },
  savUSD: {
    ethereum: T('0xb8D89678E75a973E74698c976716308abB8a46A4', 18),
    avalanche: T('0x06d47F3fb376649c3A9Dafe069B3D6E35572219E', 18),
    avalancheMint: T('0x06d47F3fb376649c3A9Dafe069B3D6E35572219E', 18),
    monad: T('0x9648db94f1e6b19e7d755585542981f97dc806c6', 18),
  },
  apyUSD: {
    ethereum: T('0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A', 18),
    base: T('0x2c271ddF484aC0386d216eB7eB9Ff02D4Dc0F6AA', 18),
    bnb: T('0xa14556f13516C53FF035858Ffd21E1625e7EADfd', 18),
    // Solana mint is 6 dp, unlike the 18 dp EVM deployments. Verified
    // on-chain: decimals 6, supply 4.32M.
    solana: T('Ex8hKasfFCfj3yGuN5TyYRUjHePgVs3uYUJRT8geT7rv', 6),
    // Hydration asset id. 18 dp here, unlike the 6 dp Solana mint — confirmed
    // against the SDK (assetOutDecimals) and the app.hydration.net quote.
    hydration: T('46', 18),
  },
  apxUSD: {
    ethereum: T('0x98A878b1Cd98131B271883B390f68D2c90674665', 18),
    base: T('0xd993935e13851dd7517af10687ec7e5022127228', 18),
    bnb: T('0x6b3788Fd6604BBF03c5378D24e57BB334BAAD4aF', 18),
    // Solana mint is 6 dp, unlike the 18 dp EVM deployments. Verified
    // on-chain: decimals 6, supply 5.64M.
    solana: T('HAYQtfJEQ9DbDbaHEhxfGsWbSZ3ywthdsVB3PuB72DYe', 6),
  },
  msUSD: {
    ethereum: T('0xab5eb14c09d416f0ac63661e57edb7aecdb9befa', 18),
    optimism: T('0x9dabae7274d28a45f0b65bf8ed201a5731492ca0', 18),
    base: T('0x526728dbc96689597f85ae4cd716d4f7fccbae9d', 18),
    plasma: T('0x29ad7fe4516909b9e498b5a65339e54791293234', 18),
  },
  msETH: {
    ethereum: T('0x64351fc9810adad17a690e4e1717df5e7e085160', 18),
    optimism: T('0x1610e3c85dd44af31ed7f33a63642012dca0c5a5', 18),
    base: T('0x7ba6f01772924a82d9626c126347a28299e98c98', 18),
    plasma: T('0x7230a9D42D622E18FDf7207041EcA18465F9F1bE', 18),
  },
  reUSD: {
    ethereum: T('0x5086bf358635B81D8C47C66d1C8b9E567Db70c72', 18),
  },
  // ——— xStocks (Backed Finance tokenised equities) ———
  // Each trades on three venues: OKX spot (the "address" is the OKX currency
  // code), Solana (Token-2022 scaled-UI mint, 8 decimals — see the scale
  // substitution in engine.ts) and X Layer, where the Uniswap liquidity sits in
  // a wrapped ERC-4626 vault (w<SYM> below) rather than the token itself.
  // Every address here was read back on-chain / from Jupiter, and the Solana
  // scale factor was cross-checked against the X Layer vault rate.
  SPYx: {
    solana: T('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', 8),
    xlayer: T('0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48', 18),
    okxCex: T('XSPY', 8),
  },
  SPCXx: {
    solana: T('Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8', 8),
    xlayer: T('0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28', 18),
    okxCex: T('XSPCX', 8),
  },
  NVDAx: {
    solana: T('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', 8),
    xlayer: T('0xc845b2894dbddd03858fd2d643b4ef725fe0849d', 18),
    okxCex: T('XNVDA', 8),
  },
  AAPLx: {
    solana: T('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', 8),
    xlayer: T('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a', 18),
    okxCex: T('XAAPL', 8),
  },
  GOOGLx: {
    solana: T('XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', 8),
    xlayer: T('0xe92f673ca36c5e2efd2de7628f815f84807e803f', 18),
    okxCex: T('XGOOGL', 8),
  },
  MSFTx: {
    solana: T('XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', 8),
    xlayer: T('0x5621737f42dae558b81269fcb9e9e70c19aa6b35', 18),
    okxCex: T('XMSFT', 8),
  },
  QQQx: {
    solana: T('Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', 8),
    xlayer: T('0xa753a7395cae905cd615da0b82a53e0560f250af', 18),
    okxCex: T('XQQQ', 8),
  },
  // Wrapped (ERC-4626) counterparts — these hold the X Layer Uniswap liquidity.
  wSPYx: { xlayer: T('0xe7e553cd128f0011777323a0b44a7b96ea1cb540', 18) },
  wSPCXx: { xlayer: T('0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072', 18) },
  wNVDAx: { xlayer: T('0xa8ddb5cd96b5222afe198316e9a57caa642850d5', 18) },
  wAAPLx: { xlayer: T('0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f', 18) },
  wGOOGLx: { xlayer: T('0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f', 18) },
  wMSFTx: { xlayer: T('0x166fbe68274b6a47e025f4ba17388c539f1fa1d0', 18) },
  wQQQx: { xlayer: T('0x4c1ae29c159838fc1b224636e28e086eb69101f7', 18) },
  RLUSD: {
    // Ripple USD. Verified on-chain: symbol RLUSD, 18 dp, ~1.4B supply.
    ethereum: T('0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', 18),
    // Both venues list it against USDT only; the USDC leg is substituted and
    // converted at the live rate (see engine.ts).
    binanceCex: T('RLUSD', 18), // exchange currency code, not an address
    bybitCex: T('RLUSD', 18), // exchange currency code, not an address
  },
  PYUSD: {
    // PayPal USD. Verified on-chain: symbol PYUSD, name "PayPal USD", 6 dp.
    ethereum: T('0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 6),
    // Verified on-chain: symbol PYUSD, name "PayPal USD", 6 dp.
    arbitrum: T('0x46850ad61c2b7d64d08c9c754f45254596696984', 6),
    solana: T('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 6),
    // Bybit lists PYUSD against USDT only; the USDC leg is substituted and
    // converted at the live rate, as for USDe above.
    bybitCex: T('PYUSD', 6), // exchange currency code, not an address
  },
  frxUSD: {
    // Frax USD — a NEW contract, not the renamed legacy FRAX
    // (0x853d…b99e still reports symbol FRAX). Verified on-chain: symbol
    // frxUSD, name "Frax USD", 18 decimals.
    ethereum: T('0xcacd6fd266af91b8aed52accc382b4e165586e29', 18),
  },
};

/** xStocks: quoted through a wrapper on X Layer and a scaled-UI mint on Solana. */
export const XSTOCK_SYMBOLS = ['SPYx', 'SPCXx', 'NVDAx', 'AAPLx', 'GOOGLx', 'MSFTx', 'QQQx'] as const;
export const isXStock = (symbol: string): boolean =>
  (XSTOCK_SYMBOLS as readonly string[]).includes(symbol);

export const tokenOn = (symbol: string, net: NetworkId): TokenDeployment | null =>
  TOKENS[symbol]?.[net] ?? null;

/** Stablecoins offered as ready-made legs when building a custom pair. */
export const CUSTOM_STABLES = ['USDC', 'USDT', 'USDG'] as const;
