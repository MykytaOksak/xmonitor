// Curated chains + protocols for DeFi position tracking. Positions are found by
// enumerating the wallet's ERC-721 holdings (Routescan) and matching the NFT
// contract to a known position manager here.

export interface PortfolioChain {
  id: string;
  name: string;
  chainId: number;
  /** Routescan network chainId path segment for the ERC-721 enumeration API. */
  routescanId: number;
  /** JSON-RPC endpoint (dev: proxied via Vite /px/*; prod: direct). */
  rpc: string;
  /** DeFiLlama chain key for token prices (coins.llama.fi). */
  llama: string;
}

export const PF_CHAINS: Record<string, PortfolioChain> = {
  plasma: {
    id: 'plasma',
    name: 'Plasma',
    chainId: 9745,
    routescanId: 9745,
    rpc: '/px/plasma',
    llama: 'plasma',
  },
  base: {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    routescanId: 8453,
    rpc: '/px/base',
    llama: 'base',
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    routescanId: 1,
    rpc: '/px/eth',
    llama: 'ethereum',
  },
  monad: {
    id: 'monad',
    name: 'Monad',
    chainId: 143,
    routescanId: 143, // Routescan does not index Monad; enumeration uses Etherscan v2
    rpc: '/px/monad',
    llama: 'monad',
  },
};

/** Scan sources the user can switch off (Portfolio scan settings), in display order. */
export const PF_SCAN_CHAINS: { id: string; name: string }[] = [
  { id: 'ethereum', name: 'Ethereum' },
  { id: 'base', name: 'Base' },
  { id: 'plasma', name: 'Plasma' },
  { id: 'monad', name: 'Monad' },
  { id: 'movement', name: 'Movement' },
];

/** Position-manager flavour — how we read a position NFT. */
export type PositionKind = 'univ3' | 'univ4';

export interface ProtocolDef {
  key: string;
  label: string;
  chain: string;
  kind: PositionKind;
  /** NonfungiblePositionManager (v3 family) or PositionManager (v4), lowercased. */
  manager: string;
  /** v4 needs its StateView/PoolManager to read pool state. */
  stateView?: string;
  /**
   * Slipstream-family CL factory, lowercased. Staked positions sit in their
   * pool's gauge rather than the wallet, so every pool's gauge is asked for the
   * wallet's staked token ids. Only for factories with a few hundred pools.
   */
  gaugeFactory?: string;
}

export const PROTOCOLS: ProtocolDef[] = [
  {
    key: 'uniswap-v3-plasma',
    label: 'Uniswap v3',
    chain: 'plasma',
    kind: 'univ3',
    manager: '0x743e03cceb4af2efa3cc76838f6e8b50b63f184c',
  },
  {
    key: 'aerodrome-slipstream-base',
    label: 'Aerodrome Slipstream',
    chain: 'base',
    kind: 'univ3',
    // Aerodrome Slipstream NonfungiblePositionManager (Base).
    manager: '0x827922686190790b37229fd06084350e74485b72',
  },
  {
    key: 'pancakeswap-v3-base',
    label: 'PancakeSwap v3',
    chain: 'base',
    kind: 'univ3',
    // PancakeSwap V3 NonfungiblePositionManager (Base).
    manager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
  },
  {
    key: 'aero-ethereum',
    label: 'Aero',
    chain: 'ethereum',
    kind: 'univ3',
    // Aero (Slipstream) NonfungiblePositionManager + CLFactory (Ethereum).
    manager: '0x4857db576ee0e45f10525ec59527bfd10beec60b',
    gaugeFactory: '0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2',
  },
  // Uniswap v4 on Plasma — manager/stateView filled once confirmed deployed.
  // { key: 'uniswap-v4-plasma', label: 'Uniswap v4', chain: 'plasma', kind: 'univ4', manager: '0x…', stateView: '0x…' },
];

export const protocolByManager = (chain: string, manager: string): ProtocolDef | undefined =>
  PROTOCOLS.find((p) => p.chain === chain && p.manager === manager.toLowerCase());

export const chainProtocolManagers = (chain: string): string[] =>
  PROTOCOLS.filter((p) => p.chain === chain).map((p) => p.manager);

/**
 * Uniswap-v4-family protocols. v4 positions live in a singleton PoolManager, so
 * reading them differs from v3 (see univ4.ts): PositionManager NFT holds the
 * PoolKey + packed tick range, pool state is read from the PoolManager's storage
 * (extsload at the `_pools` mapping slot), and poolId = keccak256(abi.encode(key)).
 */
export interface ProtocolV4Def {
  key: string;
  label: string;
  chain: string;
  /** PositionManager (ERC-721) holding v4 positions, lowercased. */
  positionManager: string;
  /** Singleton PoolManager whose storage holds each pool's slot0, lowercased. */
  poolManager: string;
  /** Storage slot of the PoolManager's `_pools` mapping (6 on the canonical deploy). */
  poolsSlot: number;
  /** Etherscan v2 chainid, used to enumerate the wallet's position token ids. */
  etherscanChainId: number;
}

export const PROTOCOLS_V4: ProtocolV4Def[] = [
  {
    key: 'uniswap-v4-monad',
    label: 'Uniswap v4',
    chain: 'monad',
    positionManager: '0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016',
    poolManager: '0x188d586ddcf52439676ca21a244753fa19f9ea8e',
    poolsSlot: 6,
    etherscanChainId: 143,
  },
];

export const chainV4Protocols = (chain: string): ProtocolV4Def[] =>
  PROTOCOLS_V4.filter((p) => p.chain === chain);
