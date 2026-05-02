import { useState, useEffect, useCallback } from 'react';
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

  const fetchProtocolState = useCallback(async () => {
    const program = getProgram();
    if (!program) return;

    const pdas = getPdas(program);
    if (!program || !pdas) return;

    setIsLoading(true);
    try {
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
          return {
            id: slice.publicKey,
            parentId,
            whaleOwnerPubkey: parentState.owner,
            amount: (slice.account.amountAvailable ?? slice.account.amount_available).toNumber() / 1e9,
            price: (slice.account.pricePerToken ?? slice.account.price_per_token).toNumber() / 1e6,
          } satisfies MarketSlice;
        }),
      );
      setSlices(enrichedSlices);

      const vaultBalance = await connection.getTokenAccountBalance(pdas.vaultPda).catch(() => ({ value: { uiAmount: 0 } }));
      try {
        const state = await parentClient.fetch(pdas.parentStatePda);
        setIsParentInitialized(true);
        const urgency = state.urgencyLevel ?? state.urgency_level;
        const lastSlice = state.lastSliceTime ?? state.last_slice_time;
        
        setVaultData({
          lockedSol: vaultBalance.value.uiAmount || 0,
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
  }, [getProgram, getPdas, connection]);

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
    const program = getProgram();
    const publicKey = wallet?.publicKey;
    if (!program || !publicKey) return logInfo('❌ Wallet not connected');

    try {
      logInfo('📡 Fetching live SOL price from Jupiter...');
      setIsLoading(true);

      const response = await fetch('https://price.jup.ag/v6/price?ids=SOL');
      const data = await response.json();
      const liveSolPrice = data?.data?.SOL?.price;
      if (typeof liveSolPrice !== 'number' || !Number.isFinite(liveSolPrice)) {
        throw new Error('Invalid Jupiter price response');
      }

      logInfo(`📈 Live Price: $${liveSolPrice.toFixed(2)}`);
      const pricePerToken = new anchor.BN(Math.floor(liveSolPrice * 1_000_000));

      logInfo('⚙️ Cranking engine with live pricing...');

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

      const tx = await crankMethod(pricePerToken)
        .accounts({
          cranker: publicKey,
          parentState: parentStatePda,
          parent_state: parentStatePda,
          childSlice: childSlicePda,
          child_slice: childSlicePda,
          systemProgram: SystemProgram.programId,
          system_program: SystemProgram.programId,
        } as any)
        .rpc();

      logInfo(`✅ Crank turned! Slice listed at live market price. TX: ${tx.slice(0, 8)}...`);
      await fetchProtocolState();
    } catch (err: any) {
      console.error(err);
      logInfo(`❌ Crank Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const buySlice = async (slice?: MarketSlice) => {
    const program = getProgram();
    if (!program || !wallet?.publicKey) return logInfo('❌ Wallet not connected');

    const targetSlice = slice ?? slices[0];
    if (!targetSlice) return logInfo('❌ No active slices.');

    try {
      logInfo('🛒 Executing Swap...');
      setIsLoading(true);

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
        })
        .rpc();

      logInfo('🤝 SWAP COMPLETE!');
      await fetchProtocolState();
      await fetchBalances();
    } catch (err: any) {
      logInfo(`❌ Swap Error: ${err.message}`);
    } finally {
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
    fetchProtocolState();
    const id = setInterval(fetchProtocolState, 12000);
    return () => clearInterval(id);
  }, [fetchProtocolState]);

  return {
    balances, vaultData, slices, isParentInitialized, isLoading, logs,
    initializeVault, turnCrank, buySlice, refreshState: fetchProtocolState
  };
};
