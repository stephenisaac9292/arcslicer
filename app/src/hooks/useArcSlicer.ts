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

// Add this outside/above your useArcSlicer hook
const translateError = (err: any, defaultMsg: string): string => {
  const msg = err?.message || String(err);
  
  // 1. The Ghost Catch
  if (msg.includes("already been processed") || msg.includes("blockhash not found")) return "ghost";
  
  // 2. Custom Anchor Errors (Matches your SlicerError enum in Rust)
  if (msg.includes("VaultEmpty") || msg.includes("0x1770")) return "The Vault is empty. Wait for the Whale to deposit.";
  if (msg.includes("SliceAlreadyFilled") || msg.includes("0x1771")) return "Too slow! Someone else just bought this slice.";
  if (msg.includes("InvalidOraclePrice") || msg.includes("0x1772")) return "Oracle offline. Please try again in a moment.";
  
  // 3. Standard Solana Errors
  if (msg.includes("insufficient funds") || msg.includes("0x1")) return "Insufficient funds for this transaction.";
  if (msg.includes("User rejected")) return "Transaction cancelled by user.";
  
  // Fallback
  return defaultMsg;
};

export const useArcSlicer = () => {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  // State Management
  const [logs, setLogs] = useState<string[]>([]);
  const [balances, setBalances] = useState({ nativeSol: 0, usdc: 0 });
  const [vaultData, setVaultData] = useState({ lockedSol: 0, slicesRemaining: 0, lastSliceTime: 0, cadenceSeconds: DEFAULT_CADENCE_SECONDS });
  const [isParentInitialized, setIsParentInitialized] = useState(false);
  const [slices, setSlices] = useState<MarketSlice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [liveSolPrice, setLiveSolPrice] = useState<number | null>(null);
  const isProcessingRef = useRef(false);

  const logInfo = (msg: string) => setLogs(prev => [...prev, msg]);

  // --- PROGRAM SETUP ---
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

  // --- DATA FETCHING ---
  const fetchBalances = useCallback(async () => {
    if (!wallet) return;
    try {
      const lamports = await connection.getBalance(wallet.publicKey);
      let usdcBal = 0;
      try {
        const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
        const usdcAccount = await getAccount(connection, usdcAta);
        usdcBal = Number(usdcAccount.amount) / 1e6;
      } catch { /* Ignore if no ATA */ }
      
      setBalances({ nativeSol: lamports / 1e9, usdc: usdcBal });
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

  const fetchProtocolState = useCallback(async () => {
    const program = getProgram();
    if (!program) return;

    const pdas = getPdas(program);
    if (!program || !pdas) return;

    setIsLoading(true);
    try {
      const oraclePrice = await fetchLiveSolPrice();
      const accountApi = program.account as any;
      const parentClient = accountApi.slicerParent || accountApi.slicer_parent;
      const sliceClient = accountApi.childSlice || accountApi.child_slice;

      // Global marketplace scrape: fetch every slice account, then enrich with parent owner.
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
      // Filter out slices owned by the currently connected wallet
      const marketSlices = enrichedSlices.filter(
        (slice) => slice.whaleOwnerPubkey.toBase58() !== wallet?.publicKey?.toBase58()
      );
      
      setSlices(marketSlices);

      const vaultBalance = await connection.getTokenAccountBalance(pdas.vaultPda).catch(() => ({ value: { uiAmount: 0 } }));
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
      setIsLoading(false);
    }
  }, [getProgram, getPdas, connection, fetchLiveSolPrice]);

  // --- ACTION HANDLERS ---
  const initializeVault = async () => {
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('❌ Wallet not connected');

    try {
      logInfo('🔒 Locking wSOL into ArcSlicer Escrow...');
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

      logInfo(`✅ Vault Initialized! TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState();
    } catch (err: any) {
      console.error(err);
      logInfo(`❌ Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const turnCrank = async () => {
    // 1. THE LOCK
    if (isProcessingRef.current) return;
    
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('❌ Wallet not connected');

    try {
      isProcessingRef.current = true;
      setIsLoading(true);
      logInfo('⚙️ Cranking engine... Blockchain is fetching live Pyth price...');

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

      logInfo(`✅ Crank turned! Slice listed via Oracle. TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState();
      
    } catch (err: any) {
      // 2. THE SANITIZER
      const cleanError = translateError(err, "Failed to turn crank.");
      if (cleanError === "ghost") {
        console.log("Caught a ghost crank double-fire.");
        return; 
      }
      logInfo(`❌ Crank Error: ${cleanError}`);
    } finally {
      // 3. THE UNLOCK
      isProcessingRef.current = false;
      setIsLoading(false);
    }
  };

  const depositFunds = async (amountSol = 0.1) => {
    if (isProcessingRef.current) return;
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('❌ Wallet not connected');

    try {
      isProcessingRef.current = true;
      setIsLoading(true);

      const amountLamports = Math.floor(amountSol * 1_000_000_000);
      if (amountLamports <= 0) return logInfo('❌ Invalid deposit amount');

      logInfo(`💧 Depositing ${amountSol.toFixed(3)} wSOL into vault...`);

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

      logInfo(`✅ Deposit complete. TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState();
      await fetchBalances();
    } catch (err: any) {
      if (err.message && err.message.includes("already been processed")) {
        console.log("Caught a ghost double-fire. Transaction actually succeeded.");
        return;
      }
      console.error(err);
      logInfo(`❌ Deposit Error: ${err.message}`);
    } finally {
      isProcessingRef.current = false;
      setIsLoading(false);
    }
  };

  const buySlice = async (slice?: MarketSlice) => {
    // 1. THE LOCK
    if (isProcessingRef.current) return;

    const program = getProgram();
    if (!program || !wallet?.publicKey) return logInfo('❌ Wallet not connected');

    const targetSlice = slice ?? slices[0];
    if (!targetSlice) return logInfo('❌ No active slices.');

    try {
      isProcessingRef.current = true;
      setIsLoading(true);
      logInfo('🛒 Executing swap... Pyth will re-price this slice on-chain.');

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

      logInfo('🤝 SWAP COMPLETE!');
      await fetchProtocolState();
      await fetchBalances();
      
    } catch (err: any) {
      // 2. THE SANITIZER
      const cleanError = translateError(err, "Swap failed.");
      if (cleanError === "ghost") {
        console.log("Caught a ghost swap double-fire.");
        return; 
      }
      logInfo(`❌ Swap Error: ${cleanError}`);
    } finally {
      // 3. THE UNLOCK
      isProcessingRef.current = false;
      setIsLoading(false);
    }
  };

  // Poll intervals
  useEffect(() => {
    fetchBalances();
    const id = setInterval(fetchBalances, 10000);
    return () => clearInterval(id);
  }, [fetchBalances]);

  useEffect(() => {
    void fetchLiveSolPrice();
    const id = setInterval(fetchLiveSolPrice, 6000);
    return () => clearInterval(id);
  }, [fetchLiveSolPrice]);

  useEffect(() => {
    fetchProtocolState();
    const id = setInterval(fetchProtocolState, 12000);
    return () => clearInterval(id);
  }, [fetchProtocolState]);

  return {
    balances, vaultData, slices, isParentInitialized, isLoading, liveSolPrice, logs,
    initializeVault, turnCrank, depositFunds, buySlice, refreshState: fetchProtocolState
  };
};
