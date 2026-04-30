import { PublicKey } from '@solana/web3.js';

// Official Devnet USDC (Circle)
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14YGWAyUcMftUZsrMF4cWeKys8nvoK");

// Official Devnet Wrapped SOL (wSOL) - Required because your Rust contract uses SPL Token transfers
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const DEFAULT_CADENCE_SECONDS = 12;