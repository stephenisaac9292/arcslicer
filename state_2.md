##############################   lib.rs 
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
pub mod state;
use state::*;

// Keep YOUR generated ID here.
declare_id!("75uhE7ybcaxboCBGC7j7hAX9N6oqY1PvearcyULUqxKi");

#[program]
pub mod arcslicer {
    use super::*;

    pub fn initialize_slicer(
        ctx: Context<InitializeSlicer>, 
        total_deposit: u64, 
        urgency_level: u8
    ) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;
        let whale = &ctx.accounts.whale;

        parent_state.owner = whale.key();
        parent_state.mint = ctx.accounts.wsol_mint.key();
        parent_state.target_mint = ctx.accounts.usdc_mint.key();
        parent_state.vault_pda = ctx.accounts.vault.key();
        parent_state.total_deposit = total_deposit;
        parent_state.remaining_balance = total_deposit;
        parent_state.urgency_level = urgency_level;
        
        let clock = Clock::get()?;
        parent_state.last_slice_time = clock.unix_timestamp;
        
        // Removed vault_bump because ATAs do not generate a custom bump in ctx
        parent_state.bump = ctx.bumps.parent_state;

        let transfer_accounts = Transfer {
            from: ctx.accounts.whale_wsol_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: whale.to_account_info(),
        };
        
        // FIX: Anchor 0.30+ uses .key() for CPI program IDs
        let cpi_program = ctx.accounts.token_program.key(); 
        let cpi_ctx = CpiContext::new(cpi_program, transfer_accounts);
        
        token::transfer(cpi_ctx, total_deposit)?;

        Ok(())
    }

    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;

        parent_state.total_deposit = parent_state.total_deposit.checked_add(amount).unwrap();
        parent_state.remaining_balance = parent_state.remaining_balance.checked_add(amount).unwrap();

        let transfer_accounts = Transfer {
            from: ctx.accounts.whale_wsol_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.whale.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.key();
        let cpi_ctx = CpiContext::new(cpi_program, transfer_accounts);

        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn engine_trigger_slice(ctx: Context<TriggerEngine>) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;
        let child_slice = &mut ctx.accounts.child_slice;
        
        require!(parent_state.remaining_balance > 0, SlicerError::VaultEmpty);

        let (oracle_price, oracle_expo) = read_pyth_price(&ctx.accounts.pyth_sol_usd_account)?;
        require!(oracle_price > 0, SlicerError::InvalidOraclePrice);

        let mut price_per_token = oracle_price as u128;
        if oracle_expo < 0 {
            let divisor = 10u128.pow(oracle_expo.unsigned_abs());
            price_per_token = price_per_token
                .checked_mul(1_000_000)
                .unwrap()
                .checked_div(divisor)
                .unwrap();
        } else {
            let multiplier = 10u128.pow(oracle_expo as u32);
            price_per_token = price_per_token
                .checked_mul(multiplier)
                .unwrap()
                .checked_mul(1_000_000)
                .unwrap();
        }

        let clock = Clock::get()?;

        let base_chunk = parent_state.total_deposit / 20; 
        let jitter = (clock.unix_timestamp as u64) % (base_chunk / 2);
        let mut slice_size = base_chunk + jitter;

        if slice_size > parent_state.remaining_balance {
            slice_size = parent_state.remaining_balance;
        }

        parent_state.remaining_balance = parent_state.remaining_balance.checked_sub(slice_size).unwrap();
        parent_state.last_slice_time = clock.unix_timestamp;

        child_slice.parent = parent_state.key();
        child_slice.amount_available = slice_size;
        child_slice.price_per_token = price_per_token as u64; 
        child_slice.is_filled = false;

        Ok(())
    }

    pub fn fill_slice(ctx: Context<FillSlice>) -> Result<()> {
        let child_slice = &mut ctx.accounts.child_slice;
        let parent = &ctx.accounts.parent;

        require!(!child_slice.is_filled, SlicerError::SliceAlreadyFilled);

        let cost_in_usdc = (child_slice.amount_available as u128)
            .checked_mul(child_slice.price_per_token as u128)
            .unwrap()
            .checked_div(1_000_000_000)
            .unwrap() as u64;

        let cpi_program = ctx.accounts.token_program.key();

        // MEMORY SCOPE 1: Execute USDC Transfer and immediately clear stack
        {
            let usdc_transfer = Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.whale_usdc_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            };
            let cpi_usdc_ctx = CpiContext::new(cpi_program, usdc_transfer);
            token::transfer(cpi_usdc_ctx, cost_in_usdc)?;
        }

        // MEMORY SCOPE 2: Execute wSOL Transfer and immediately clear stack
        {
            let owner_key = parent.owner;
            let parent_bump = parent.bump;
            let parent_seeds = &[
                b"parent",
                owner_key.as_ref(),
                &[parent_bump],
            ];
            let signer = &[&parent_seeds[..]];

            let sol_transfer = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.buyer_wsol_account.to_account_info(),
                authority: parent.to_account_info(),
            };
            let cpi_sol_ctx = CpiContext::new_with_signer(cpi_program, sol_transfer, signer);
            token::transfer(cpi_sol_ctx, child_slice.amount_available)?;
        }

        child_slice.is_filled = true;

        Ok(())
    }
}

const PYTH_MAGIC: u32 = 0xa1b2c3d4;
const PYTH_PRICE_ACCOUNT_TYPE: u32 = 3;
const PYTH_STATUS_TRADING: u8 = 1;
const PYTH_EXPO_OFFSET: usize = 20;
const PYTH_PREV_PRICE_OFFSET: usize = 184;
const PYTH_AGG_PRICE_OFFSET: usize = 208;
const PYTH_AGG_STATUS_OFFSET: usize = 224;
const PYTH_PUSH_FEED_ID_OFFSET: usize = 41;
const PYTH_PUSH_PRICE_OFFSET: usize = 73;
const PYTH_PUSH_EXPO_OFFSET: usize = 89;
const PYTH_PUSH_MIN_SIZE: usize = 133;
const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

fn read_pyth_price(price_account: &AccountInfo) -> Result<(i64, i32)> {
    let data = price_account.try_borrow_data()?;

    if data.len() >= 232 && read_u32_le(&data, 0) == PYTH_MAGIC {
        return read_legacy_pyth_price(&data);
    }

    read_push_pyth_price(&data)
}

fn read_legacy_pyth_price(data: &[u8]) -> Result<(i64, i32)> {
    require!(data.len() >= 232, SlicerError::InvalidOracleAccount);

    let magic = read_u32_le(&data, 0);
    let account_type = read_u32_le(&data, 8);
    require!(
        magic == PYTH_MAGIC && account_type == PYTH_PRICE_ACCOUNT_TYPE,
        SlicerError::InvalidOracleAccount
    );

    let expo = read_i32_le(&data, PYTH_EXPO_OFFSET);
    let price = if data[PYTH_AGG_STATUS_OFFSET] == PYTH_STATUS_TRADING {
        read_i64_le(&data, PYTH_AGG_PRICE_OFFSET)
    } else {
        read_i64_le(&data, PYTH_PREV_PRICE_OFFSET)
    };

    Ok((price, expo))
}

fn read_push_pyth_price(data: &[u8]) -> Result<(i64, i32)> {
    require!(data.len() >= PYTH_PUSH_MIN_SIZE, SlicerError::InvalidOracleAccount);
    require!(
        data[PYTH_PUSH_FEED_ID_OFFSET..PYTH_PUSH_FEED_ID_OFFSET + 32] == PYTH_SOL_USD_FEED_ID,
        SlicerError::InvalidOracleAccount
    );

    Ok((
        read_i64_le(data, PYTH_PUSH_PRICE_OFFSET),
        read_i32_le(data, PYTH_PUSH_EXPO_OFFSET),
    ))
}

fn read_u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_i32_le(data: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_i64_le(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[derive(Accounts)]
pub struct InitializeSlicer<'info> {
    #[account(mut)]
    pub whale: Signer<'info>,

    pub wsol_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = whale,
        space = 8 + 200, 
        seeds = [b"parent", whale.key().as_ref()],
        bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    #[account(
        init,
        payer = whale,
        associated_token::mint = wsol_mint,
        associated_token::authority = parent_state, 
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = whale,
    )]
    pub whale_wsol_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub whale: Signer<'info>,

    #[account(
        mut,
        seeds = [b"parent", whale.key().as_ref()],
        bump = parent_state.bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    #[account(
        mut,
        associated_token::mint = parent_state.mint,
        associated_token::authority = parent_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = parent_state.mint,
        associated_token::authority = whale,
    )]
    pub whale_wsol_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TriggerEngine<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"parent", parent_state.owner.as_ref()],
        bump = parent_state.bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    #[account(
        init,
        payer = cranker,
        space = 8 + 32 + 8 + 8 + 1,
        seeds = [b"slice", parent_state.key().as_ref(), parent_state.remaining_balance.to_le_bytes().as_ref()],
        bump
    )]
    pub child_slice: Account<'info, ChildSlice>, // FIX: Reverted back to ChildSlice

    pub system_program: Program<'info, System>,

    /// CHECK: We are reading the live Pyth price feed.
    pub pyth_sol_usd_account: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FillSlice<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"parent", parent.owner.as_ref()], 
        bump = parent.bump
    )]
    pub parent: Box<Account<'info, SlicerParent>>,

    #[account(mut)]
    pub child_slice: Box<Account<'info, ChildSlice>>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = parent,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_wsol_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub whale_usdc_account: Box<Account<'info, TokenAccount>>,

    pub wsol_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum SlicerError {
    #[msg("The vault is empty, cannot slice any more funds.")]
    VaultEmpty,

    #[msg("This slice has already been purchased.")]
    SliceAlreadyFilled,

    #[msg("The Pyth price feed returned an invalid SOL/USD price.")]
    InvalidOraclePrice,

    #[msg("The provided Pyth account is not a valid price feed.")]
    InvalidOracleAccount,
}

####### useArcslicer.ts hook 
import { useState, useEffect, useCallback, useRef } from 'react';
import { useConnection, useAnchorWallet } from '@solana/wallet-adapter-react';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Buffer } from 'buffer';
import idl from '../idl/arcslicer.json';
import { USDC_MINT, WSOL_MINT, DEFAULT_CADENCE_SECONDS } from '../config/constants';

type MarketSlice = {
  id: PublicKey;
  parentId: PublicKey;
  whaleOwnerPubkey: PublicKey;
  amount: number;
  price: number;
  totalCost: number;
};

const PYTH_DEVNET_SOL_USD = new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
const PYTH_SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const PYTH_PUSH_FEED_ID_OFFSET = 41;
const PYTH_PUSH_PRICE_OFFSET = 73;
const PYTH_PUSH_EXPO_OFFSET = 89;

const parsePythSolPrice = (data: Buffer) => {
  if (
    data.length < 133 ||
    data.subarray(PYTH_PUSH_FEED_ID_OFFSET, PYTH_PUSH_FEED_ID_OFFSET + 32).toString('hex') !== PYTH_SOL_USD_FEED_ID
  ) {
    return null;
  }

  const price = Number(data.readBigInt64LE(PYTH_PUSH_PRICE_OFFSET));
  const expo = data.readInt32LE(PYTH_PUSH_EXPO_OFFSET);
  return price > 0 ? price * 10 ** expo : null;
};

const translateError = (err: any, defaultMsg: string): string => {
  const msg = err?.message || String(err);
  
  if (msg.includes("already been processed") || msg.includes("blockhash not found")) return "ghost";
  if (msg.includes("VaultEmpty") || msg.includes("0x1770")) return "Vault is empty. Awaiting deposit.";
  if (msg.includes("SliceAlreadyFilled") || msg.includes("0x1771")) return "Slice already filled by another user.";
  if (msg.includes("InvalidOraclePrice") || msg.includes("0x1772")) return "Oracle offline. Retry pending.";
  if (msg.includes("insufficient funds") || msg.match(/\b0x1\b/)) return "Insufficient funds for this transaction.";
  if (msg.includes("User rejected")) return "Transaction cancelled by user.";
  
  return defaultMsg;
};

export const useArcSlicer = () => {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [logs, setLogs] = useState<string[]>([]);
  const [balances, setBalances] = useState({ nativeSol: 0, usdc: 0 });
  const [vaultData, setVaultData] = useState({ lockedSol: 0, slicesRemaining: 0, lastSliceTime: 0, cadenceSeconds: DEFAULT_CADENCE_SECONDS });
  const [isParentInitialized, setIsParentInitialized] = useState(false);
  const [slices, setSlices] = useState<MarketSlice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [liveSolPrice, setLiveSolPrice] = useState<number | null>(null);
  const isProcessingRef = useRef(false);

  const logInfo = (msg: string) => setLogs(prev => [...prev, msg]);

  const getProgram = useCallback(() => {
    if (!wallet) return null;
    const provider = new anchor.AnchorProvider(connection, wallet, { preflightCommitment: 'processed' });
    return new anchor.Program(idl as anchor.Idl, provider);
  }, [connection, wallet]);

  const getPdas = useCallback((program: anchor.Program) => {
    if (!wallet) return null;
    const [parentStatePda] = PublicKey.findProgramAddressSync([Buffer.from('parent'), wallet.publicKey.toBuffer()], program.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), parentStatePda.toBuffer()], program.programId);
    return { parentStatePda, vaultPda };
  }, [wallet]);

  const fetchBalances = useCallback(async () => {
    if (!wallet) return;
    try {
      const lamports = await connection.getBalance(wallet.publicKey);
      let newUsdcBal: number | null = null; 

      try {
        const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
        const accountInfo = await connection.getAccountInfo(usdcAta);
        
        if (accountInfo) {
          const usdcAccount = await getAccount(connection, usdcAta);
          newUsdcBal = Number(usdcAccount.amount) / 1e6;
        } else {
          newUsdcBal = 0; 
        }
      } catch { 
        // Suppress expected network lag errors
      }
      
      setBalances(prev => ({ 
        nativeSol: lamports / 1e9, 
        usdc: newUsdcBal !== null ? newUsdcBal : prev.usdc 
      }));
    } catch (e) {
      console.error("Balance fetch error:", e);
    }
  }, [connection, wallet]);

  const fetchLiveSolPrice = useCallback(async () => {
    const accountInfo = await connection.getAccountInfo(PYTH_DEVNET_SOL_USD);
    if (!accountInfo) return null;

    const price = parsePythSolPrice(Buffer.from(accountInfo.data));
    if (price) {
      setLiveSolPrice(price);
      setSlices(prev => prev.map(slice => ({
        ...slice,
        price,
        totalCost: slice.amount * price,
      })));
    }
    return price;
  }, [connection]);

  const fetchProtocolState = useCallback(async (isBackground = false) => {
    const program = getProgram();
    if (!program) return;

    const pdas = getPdas(program);
    if (!program || !pdas) return;

    if (!isBackground) setIsLoading(true);
    
    try {
      const oraclePrice = await fetchLiveSolPrice();
      const accountApi = program.account as any;
      const parentClient = accountApi.slicerParent || accountApi.slicer_parent;
      const sliceClient = accountApi.childSlice || accountApi.child_slice;

      const allSlices = await sliceClient.all();
      const activeSlicesRaw = allSlices.filter((slice: any) => !(slice.account.isFilled ?? slice.account.is_filled));

      const enrichedSlices = await Promise.all(
        activeSlicesRaw.map(async (slice: any) => {
          const parentId = slice.account.parent;
          const parentState = await parentClient.fetch(parentId);
          const amount = (slice.account.amountAvailable ?? slice.account.amount_available).toNumber() / 1e9;
          const storedPrice = (slice.account.pricePerToken ?? slice.account.price_per_token).toNumber() / 1e6;
          const displayPrice = oraclePrice ?? storedPrice;
          return {
            id: slice.publicKey,
            parentId,
            whaleOwnerPubkey: parentState.owner,
            amount,
            price: displayPrice,
            totalCost: amount * displayPrice,
          } satisfies MarketSlice;
        }),
      );
      
      const marketSlices = enrichedSlices.filter(
        (slice) => slice.whaleOwnerPubkey.toBase58() !== wallet?.publicKey?.toBase58()
      );
      
      setSlices(marketSlices);

      try {
        const state = await parentClient.fetch(pdas.parentStatePda);
        setIsParentInitialized(true);
        const urgency = state.urgencyLevel ?? state.urgency_level;
        const lastSlice = state.lastSliceTime ?? state.last_slice_time;
        
        const rawBalance = (state.remainingBalance ?? state.remaining_balance)?.toNumber() || 0;
        const formattedBalance = rawBalance / 1_000_000_000;
        
        setVaultData({
          lockedSol: formattedBalance,
          slicesRemaining: enrichedSlices.filter((slice) => slice.parentId.equals(pdas.parentStatePda)).length,
          lastSliceTime: lastSlice.toNumber(),
          cadenceSeconds: urgency === 1 ? 24 : urgency === 3 ? 6 : DEFAULT_CADENCE_SECONDS
        });
      } catch {
        setIsParentInitialized(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!isBackground) setIsLoading(false);
    }
  }, [getProgram, getPdas, connection, fetchLiveSolPrice, wallet?.publicKey]);

  const initializeVault = async () => {
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('Wallet not connected.');

    try {
      logInfo('Initializing vault protocol.');
      setIsLoading(true);

      const [parentStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('parent'), publicKey.toBuffer()],
        program.programId
      );

      const vaultPdaAta = getAssociatedTokenAddressSync(
        WSOL_MINT,
        parentStatePda,
        true
      );

      const whaleWsolAccount = getAssociatedTokenAddressSync(
        WSOL_MINT,
        publicKey
      );

      const tx = await program.methods
        .initializeSlicer(
          new anchor.BN(100_000_000), 
          1 
        )
        .accounts({
          whale: publicKey,
          wsolMint: WSOL_MINT,
          usdcMint: USDC_MINT,
          parentState: parentStatePda,
          vault: vaultPdaAta,
          whaleWsolAccount: whaleWsolAccount,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      logInfo(`Vault initialized. TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState(false);
    } catch (err: any) {
      console.error(err);
      logInfo(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const turnCrank = async () => {
    if (isProcessingRef.current) return;
    
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('Wallet not connected.');

    try {
      isProcessingRef.current = true;
      setIsLoading(true);
      logInfo('Executing crank. Fetching oracle state.');

      const [parentStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('parent'), publicKey.toBuffer()],
        program.programId
      );

      const accountApi = program.account as any;
      const parentClient = accountApi.slicerParent || accountApi.slicer_parent;
      const parentStateData = await parentClient.fetch(parentStatePda);
      const remainingBalance = parentStateData.remainingBalance ?? parentStateData.remaining_balance;

      const remainingBalanceBuffer = Buffer.alloc(8);
      remainingBalanceBuffer.writeBigUInt64LE(BigInt(remainingBalance.toString()));

      const [childSlicePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('slice'), parentStatePda.toBuffer(), remainingBalanceBuffer],
        program.programId
      );

      const methodsApi = program.methods as any;
      const crankMethod = methodsApi.engineTriggerSlice || methodsApi.engine_trigger_slice;

      const tx = await crankMethod()
        .accounts({
          cranker: publicKey,
          parentState: parentStatePda,
          parent_state: parentStatePda,
          childSlice: childSlicePda,
          child_slice: childSlicePda,
          systemProgram: SystemProgram.programId,
          system_program: SystemProgram.programId,
          pythSolUsdAccount: PYTH_DEVNET_SOL_USD,
          pyth_sol_usd_account: PYTH_DEVNET_SOL_USD,
        } as any)
        .rpc();

      logInfo(`Crank executed. Slice listed. TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState(false);
      
    } catch (err: any) {
      const cleanError = translateError(err, "Failed to execute crank.");
      if (cleanError === "ghost") {
        return; 
      }
      logInfo(`Crank error: ${cleanError}`);
    } finally {
      isProcessingRef.current = false;
      setIsLoading(false);
    }
  };

  const depositFunds = async (amountSol = 0.1) => {
    if (isProcessingRef.current) return;
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('Wallet not connected.');

    try {
      isProcessingRef.current = true;
      setIsLoading(true);

      const amountLamports = Math.floor(amountSol * 1_000_000_000);
      if (amountLamports <= 0) return logInfo('Invalid deposit amount.');

      logInfo(`Depositing ${amountSol.toFixed(3)} wSOL.`);

      const [parentStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('parent'), publicKey.toBuffer()],
        program.programId
      );

      const vaultPdaAta = getAssociatedTokenAddressSync(
        WSOL_MINT,
        parentStatePda,
        true
      );

      const whaleWsolAccount = getAssociatedTokenAddressSync(
        WSOL_MINT,
        publicKey
      );

      const methodsApi = program.methods as any;
      const depositMethod = methodsApi.depositFunds || methodsApi.deposit_funds;

      const tx = await depositMethod(new anchor.BN(amountLamports))
        .accounts({
          whale: publicKey,
          parentState: parentStatePda,
          parent_state: parentStatePda,
          vault: vaultPdaAta,
          whaleWsolAccount: whaleWsolAccount,
          whale_wsol_account: whaleWsolAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token_program: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      logInfo(`Deposit complete. TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState(false);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      await fetchBalances(); 
    } catch (err: any) {
      if (err.message && err.message.includes("already been processed")) {
        return;
      }
      console.error(err);
      logInfo(`Deposit error: ${err.message}`);
    } finally {
      isProcessingRef.current = false;
      setIsLoading(false);
    }
  };

  const buySlice = async (slice?: MarketSlice) => {
    if (isProcessingRef.current) return;

    const program = getProgram();
    if (!program || !wallet?.publicKey) return logInfo('Wallet not connected.');

    const targetSlice = slice ?? slices[0];
    if (!targetSlice) return logInfo('No active slices available.');

    try {
      isProcessingRef.current = true;
      setIsLoading(true);
      logInfo('Executing swap. Verifying oracle state.');

      const buyerPublicKey = wallet.publicKey;
      const buyerWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, buyerPublicKey);
      const buyerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, buyerPublicKey);
      const whaleUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, targetSlice.whaleOwnerPubkey);
      const vaultPdaAta = getAssociatedTokenAddressSync(WSOL_MINT, targetSlice.parentId, true);

      await program.methods.fillSlice()
        .accounts({
          buyer: buyerPublicKey,
          parent: targetSlice.parentId,
          childSlice: targetSlice.id,
          child_slice: targetSlice.id,
          vault: vaultPdaAta,
          buyerUsdcAccount: buyerUsdcAta,
          buyer_usdc_account: buyerUsdcAta,
          buyerWsolAccount: buyerWsolAta,
          buyer_wsol_account: buyerWsolAta,
          whaleUsdcAccount: whaleUsdcAta,
          whale_usdc_account: whaleUsdcAta,
          wsolMint: WSOL_MINT,
          wsol_mint: WSOL_MINT,
          usdcMint: USDC_MINT,
          usdc_mint: USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          token_program: TOKEN_PROGRAM_ID,
          pythSolUsdAccount: PYTH_DEVNET_SOL_USD,
          pyth_sol_usd_account: PYTH_DEVNET_SOL_USD,
        })
        .rpc();

      logInfo('Swap complete.');
      
      setSlices(prev => prev.filter(s => s.id.toBase58() !== targetSlice.id.toBase58()));

      await fetchProtocolState(false);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      await fetchBalances(); 
      
    } catch (err: any) {
      const cleanError = translateError(err, "Swap execution failed.");
      if (cleanError === "ghost") {
        return; 
      }
      logInfo(`Swap error: ${cleanError}`);
    } finally {
      isProcessingRef.current = false;
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  useEffect(() => {
    void fetchLiveSolPrice();
    const id = setInterval(fetchLiveSolPrice, 2000);
    return () => clearInterval(id);
  }, [fetchLiveSolPrice]);

  useEffect(() => {
    fetchProtocolState(false); 
    const id = setInterval(() => {
      fetchProtocolState(true); 
    }, 2000);
    return () => clearInterval(id);
  }, [fetchProtocolState]);

  return {
    balances, vaultData, slices, isParentInitialized, isLoading, liveSolPrice, logs,
    initializeVault, turnCrank, depositFunds, buySlice, 
    refreshState: () => { 
      fetchProtocolState(false); 
      fetchBalances(); 
    } 
  };
};

##############   usefaucet.ts hook 
import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Keypair, Transaction, LAMPORTS_PER_SOL, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { 
  createAssociatedTokenAccountInstruction, 
  getAssociatedTokenAddressSync, 
  createMintToInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT
} from '@solana/spl-token';
import { USDC_MINT } from '../config/constants';

export const useFaucet = () => {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [isDropping, setIsDropping] = useState(false);
  const [faucetLog, setFaucetLog] = useState<string>('');

  const requestAirdrop = async () => {
    if (!publicKey) return setFaucetLog('Connect wallet first.');
    setIsDropping(true);
    setFaucetLog('Bypassing public faucet. Booting God Key...');

    try {
      const secretKeyString = import.meta.env.VITE_FAUCET_SECRET_KEY;
      if (!secretKeyString) throw new Error("Faucet Secret Key missing in .env");
      
      const secretKeyArray = Uint8Array.from(JSON.parse(secretKeyString));
      const funderKeypair = Keypair.fromSecretKey(secretKeyArray);

      setFaucetLog('Packaging Gas, wSOL, and USDC...');
      const tx = new Transaction();

      // ==========================================
      // PART 1: SEND NATIVE GAS (0.2 SOL)
      // ==========================================
      tx.add(
        SystemProgram.transfer({
          fromPubkey: funderKeypair.publicKey,
          toPubkey: publicKey,
          lamports: 0.2 * LAMPORTS_PER_SOL,
        })
      );

      // ==========================================
      // PART 2: PRINT THE USDC (2,000)
      // ==========================================
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
      const usdcAtaInfo = await connection.getAccountInfo(userUsdcAta);

      if (!usdcAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            funderKeypair.publicKey, // God Key pays the rent to create the bucket
            userUsdcAta,
            publicKey, // User owns the bucket
            USDC_MINT
          )
        );
      }

      tx.add(
        createMintToInstruction(
          USDC_MINT, userUsdcAta, funderKeypair.publicKey, 2000 * 1_000_000
        )
      );
      // ==========================================
      // PART 3: WRAP THE SOL (0.5 wSOL)
      // ==========================================
      const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey);
      const wsolAtaInfo = await connection.getAccountInfo(userWsolAta);

      if (!wsolAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            funderKeypair.publicKey, // God Key pays the rent
            userWsolAta, 
            publicKey, // User owns the bucket
            NATIVE_MINT
          )
        );
      }

      // Move 0.5 SOL from God Key directly into the User's wSOL bucket
      tx.add(
        SystemProgram.transfer({
          fromPubkey: funderKeypair.publicKey,
          toPubkey: userWsolAta,
          lamports: 0.5 * LAMPORTS_PER_SOL,
        })
      );

      // Officially "wrap" it
      tx.add(createSyncNativeInstruction(userWsolAta));

      // ==========================================
      // EXECUTE (SILENTLY)
      // ==========================================
      setFaucetLog('Executing silent delivery...');
      
      // Because the God Key is doing everything, we don't ask the User's Phantom to sign!
      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [funderKeypair] // Only the God Key signs
      );

      setFaucetLog(`✅ Delivery Complete! Signature: ${signature.slice(0, 8)}...`);

    } catch (error: any) {
      console.error(error);
      setFaucetLog(`❌ Faucet Failed: ${error.message}`);
    } finally {
      setIsDropping(false);
    }
  };

  return { requestAirdrop, isDropping, faucetLog };
};

################  App.tsx 
import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { Activity, ArrowUpRight, Slash, Droplets } from 'lucide-react';
import { useArcSlicer } from './hooks/useArcSlicer';
import { useFaucet } from './hooks/useFaucet';
import './App.css';

function App() {
  const { publicKey } = useWallet();
  const {
    balances, vaultData, slices, isParentInitialized, isLoading, liveSolPrice, logs,
    initializeVault, turnCrank, depositFunds, buySlice, refreshState
  } = useArcSlicer();

  const { requestAirdrop, isDropping, faucetLog } = useFaucet();

  const [activeMode, setActiveMode] = useState<'whale' | 'buyer'>('buyer');
  
  // THE FIX: We have to tell React what 'depositAmount' is!
  const [depositAmount, setDepositAmount] = useState<string>('0.1');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <span className="brand-mark"><Slash size={20} /></span>
          <div><h1 className="brand-name">ArcSlicer</h1></div>
        </div>

        <nav className="nav-links">
          <button
            className={activeMode === 'buyer' ? 'active-tab text-green-400' : 'ghost-link'}
            onClick={() => setActiveMode('buyer')}
          >
            Dark Pool Marketplace
          </button>
          <button
            className={activeMode === 'whale' ? 'active-tab text-purple-400' : 'ghost-link'}
            onClick={() => setActiveMode('whale')}
          >
            Whale Command Center
          </button>
        </nav>

        <div className="topbar-controls">
          <WalletMultiButton className="wallet-compact-btn" />
        </div>
      </header>

      <main className="layout">
        <aside className="console-panel">
          <div className="console-head">
            <span>{activeMode === 'whale' ? 'Vault Execution Console' : 'Active Market'}</span>
            <span className="live-pill"><Activity size={14} /> Live</span>
          </div>

          {publicKey ? (
            <div className="session-stack">
              <section className="wallet-map-card">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h4 className="text-gray-400 text-sm uppercase tracking-wider mb-2">Your Wallet</h4>
                    <dl className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-800/50 p-2 rounded">
                        <dt className="text-xs text-gray-500">Gas (Native SOL)</dt>
                        <dd className="font-mono font-bold text-white">{balances.nativeSol.toFixed(4)}</dd>
                      </div>
                      <div className="bg-gray-800/50 p-2 rounded">
                        <dt className="text-xs text-gray-500">Trade Asset (USDC)</dt>
                        <dd className="font-mono font-bold text-green-400">{balances.usdc.toFixed(2)}</dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <div className="faucet-container border border-blue-500/30 bg-blue-900/20 p-3 rounded-lg mt-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <h5 className="text-blue-400 font-bold text-sm flex items-center gap-2"><Droplets size={14} /> Tester Faucet</h5>
                      <p className="text-xs text-gray-400">Need funds? Get Gas, wSOL, and USDC.</p>
                    </div>
                    <button
                      onClick={requestAirdrop}
                      disabled={isDropping}
                      className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white text-xs px-4 py-2 rounded font-bold transition-colors"
                    >
                      {isDropping ? 'Airdropping...' : 'Get Tokens'}
                    </button>
                  </div>
                  {faucetLog && <p className="mt-2 text-xs text-blue-300 font-mono">{faucetLog}</p>}
                </div>
              </section>

              {activeMode === 'whale' && (
                <>
                  <section className="shadow-monitor border-purple-500/50">
                    <div className="shadow-monitor-head">
                      <h4 className="text-purple-400">Vault Status</h4>
                      <button className="refresh-btn" onClick={refreshState} disabled={isLoading}>
                        {isLoading ? 'Syncing...' : 'Sync'}
                      </button>
                    </div>
                    <div className="shadow-grid">
                      <article className="shadow-block">
                        <p className="shadow-label">Total Locked</p>
                        <p className="shadow-value text-white">{vaultData.lockedSol.toFixed(4)} <span className="text-purple-400 text-sm">wSOL</span></p>
                        <p className="shadow-meta mt-2 pt-2 border-t border-gray-700">Slices Pending: <span className="text-white font-bold">{vaultData.slicesRemaining}</span></p>
                      </article>
                    </div>
                  </section>

                  <div className="action-grid">
                    <button className="launch-btn bg-purple-900/50 hover:bg-purple-800 border border-purple-500 text-white" onClick={initializeVault}>
                      1: Initialize Vault <ArrowUpRight size={17} />
                    </button>
                    <button className="launch-btn setup-btn bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50" onClick={turnCrank} disabled={!isParentInitialized}>
                      2: Turn Crank (Jitter) <ArrowUpRight size={17} />
                    </button>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        disabled={!isParentInitialized || isLoading}
                        className="bg-gray-900 border border-gray-700 text-white rounded px-3 py-2 w-24 text-sm outline-none focus:border-purple-500 transition-colors"
                        min="0.01"
                        step="0.01"
                      />
                      <button 
                        className="launch-btn flex-1" 
                        onClick={() => void depositFunds(Number(depositAmount))} 
                        disabled={!isParentInitialized || isLoading || Number(depositAmount) <= 0}
                      >
                        {isLoading ? 'Processing...' : `3: Deposit wSOL`} <ArrowUpRight size={17} />
                      </button>
                    </div>
                  </div>
                </>
              )}

              {activeMode === 'buyer' && (
                <>
                  <section className="shadow-monitor border-green-500/50">
                    <div className="shadow-monitor-head">
                      <div>
                        <h4 className="text-green-400">Available Slices</h4>
                        <p className="text-xs text-gray-500">
                          Pyth oracle: {liveSolPrice ? `$${liveSolPrice.toFixed(4)} / SOL` : 'syncing...'} - 6s poll
                        </p>
                      </div>
                      <button className="refresh-btn" onClick={refreshState} disabled={isLoading}>
                        {isLoading ? 'Syncing...' : 'Sync'}
                      </button>
                    </div>

                    <div className="shadow-grid">
                      <article className="shadow-block">
                        {slices.length === 0 ? <p className="shadow-wait animate-pulse text-gray-500">Scanning pool for active slices...</p> : (
                          <div className="slice-list">
                            {slices.map((slice) => {
                              const executionPrice = liveSolPrice ?? slice.price;
                              const estimatedCost = slice.amount * executionPrice;

                              return (
                                <div key={slice.id.toBase58()} className="slice-row flex justify-between items-center border-b border-gray-700/50 py-3">
                                  <div className="flex flex-col">
                                    <span className="font-bold text-white text-lg">{slice.amount.toFixed(4)} wSOL</span>
                                    <span className="text-xs text-gray-400">Live price: {executionPrice.toFixed(4)} USDC / SOL</span>
                                    <span className="text-xs text-green-300 font-mono">Est. debit: {estimatedCost.toFixed(2)} USDC</span>
                                    <span className="text-[10px] text-gray-600">Final amount is rechecked by Pyth on-chain.</span>
                                  </div>
                                  <button 
                                    onClick={() => void buySlice(slice)}
                                    className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded text-white text-sm font-bold transition-colors"
                                    disabled={isLoading}
                                  >
                                    Buy This Slice
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </article>
                    </div>
                  </section>
                </>
              )}

              <div className="terminal-log mt-6 bg-black/50 p-3 rounded font-mono text-xs border border-gray-800">
                <div className="text-gray-500 mb-2 border-b border-gray-800 pb-1">System Logs</div>
                {logs.length === 0 ? <span className="text-gray-600">System ready...</span> : logs.map((log, i) => (
                  <div key={i} className={log.includes('❌') ? 'text-red-400' : log.includes('OK') || log.includes('✅') ? 'text-green-400' : 'text-gray-300'}>
                    {log}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="session-card disconnected text-center py-12">
              <Activity className="mx-auto text-gray-600 mb-4" size={48} />
              <h3 className="text-xl font-bold text-white mb-2">Connect Identity</h3>
              <p className="text-gray-400 mb-6">Connect your wallet to enter the Dark Pool.</p>
              <WalletMultiButton className="wallet-main-btn mx-auto" />
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;
