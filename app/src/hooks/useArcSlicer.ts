import { useState, useEffect, useCallback } from 'react';
import { useConnection, useAnchorWallet } from '@solana/wallet-adapter-react';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Buffer } from 'buffer';
import idl from '../idl/arcslicer.json';
import { USDC_MINT, WSOL_MINT, DEFAULT_CADENCE_SECONDS } from '../config/constants';

export const useArcSlicer = () => {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  // State Management
  const [logs, setLogs] = useState<string[]>([]);
  const [balances, setBalances] = useState({ nativeSol: 0, usdc: 0 });
  const [vaultData, setVaultData] = useState({ lockedSol: 0, slicesRemaining: 0, lastSliceTime: 0, cadenceSeconds: DEFAULT_CADENCE_SECONDS });
  const [isParentInitialized, setIsParentInitialized] = useState(false);
  const [slices, setSlices] = useState<any[]>([]);
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
    const pdas = getPdas(program!);
    if (!program || !pdas) return;

    setIsLoading(true);
    try {
      // 1. Fetch Slices (Cast program.account to any to bypass strict IDL TS checks)
      const accountApi = program.account as any;
      
      // Handle both camelCase and snake_case just in case your IDL didn't update perfectly
      const sliceClient = accountApi.childSlice || accountApi.child_slice;
      const parentClient = accountApi.slicerParent || accountApi.slicer_parent;

      const allSlices = await sliceClient.all([
        { memcmp: { offset: 8, bytes: pdas.parentStatePda.toBase58() } }
      ]);
      
      // Explicitly type (s: any) to fix the implicit any error
      const activeSlices = allSlices
        .filter((s: any) => !(s.account.isFilled ?? s.account.is_filled))
        .map((s: any) => ({
          id: s.publicKey.toBase58(),
          amount: (s.account.amountAvailable ?? s.account.amount_available).toNumber() / 1e9,
          price: (s.account.pricePerToken ?? s.account.price_per_token).toNumber() / 1e6
        }));
      setSlices(activeSlices);

      // 2. Fetch Vault & Parent
      const vaultBalance = await connection.getTokenAccountBalance(pdas.vaultPda).catch(() => ({ value: { uiAmount: 0 } }));
      try {
        const state = await parentClient.fetch(pdas.parentStatePda);
        setIsParentInitialized(true);
        const urgency = state.urgencyLevel ?? state.urgency_level;
        const lastSlice = state.lastSliceTime ?? state.last_slice_time;
        
        setVaultData({
          lockedSol: vaultBalance.value.uiAmount || 0,
          slicesRemaining: activeSlices.length,
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
    const pdas = getPdas(program!);
    if (!program || !pdas) return logInfo("ERROR: Program not ready.");

    try {
      logInfo('🔒 Locking wSOL into ArcSlicer Escrow...');
      const whaleWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet!.publicKey);
      
      await program.methods.initializeSlicer(new anchor.BN(1000 * 1e9), 2)
        .accounts({
          whale: wallet!.publicKey,
          mint: WSOL_MINT,
          targetMint: USDC_MINT,
          parentState: pdas.parentStatePda,
          vault: pdas.vaultPda,
          whaleTokenAccount: whaleWsolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }).rpc();
      
      logInfo('✅ Vault Initialized!');
      fetchProtocolState();
    } catch (err: any) { logInfo(`❌ Error: ${err.message}`); }
  };

  const turnCrank = async () => {
    const program = getProgram();
    const pdas = getPdas(program!);
    if (!program || !pdas) return;

    try {
      logInfo('INFO: Cranking engine...');
      const accountApi = program.account as any;
      const parentClient = accountApi.slicerParent || accountApi.slicer_parent;
      
      const parentData = await parentClient.fetch(pdas.parentStatePda);
      const remainingBalance = parentData.remainingBalance ?? parentData.remaining_balance;
      
      const [childSlicePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('slice'), pdas.parentStatePda.toBuffer(), remainingBalance.toArrayLike(Buffer, 'le', 8)],
        program.programId
      );

      // Handle IDL method naming variations
      const methodsApi = program.methods as any;
      const crankMethod = methodsApi.engineTriggerSlice || methodsApi.engine_trigger_slice;

      await crankMethod()
        .accounts({
          cranker: wallet!.publicKey,
          parentState: pdas.parentStatePda,
          parent_state: pdas.parentStatePda, // Fallback for snake_case
          childSlice: childSlicePda,
          child_slice: childSlicePda, // Fallback for snake_case
          systemProgram: SystemProgram.programId,
          system_program: SystemProgram.programId, // Fallback
        }).rpc();

      logInfo('OK: Crank turned. New slice created.');
      fetchProtocolState();
    } catch (err: any) { logInfo(`❌ Crank Error: ${err.message}`); }
  };

  const buySlice = async () => {
    const program = getProgram();
    const pdas = getPdas(program!);
    if (!program || !pdas || slices.length === 0) return logInfo("❌ No active slices.");

    try {
      logInfo('🛒 Executing Swap...');
      const activeSliceId = slices[0].id;
      const buyerWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet!.publicKey);
      const buyerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, wallet!.publicKey);
      
      // Dummy Whale Recipient for testing
      const dummyWhale = Keypair.generate();
      const dummyWhaleUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, dummyWhale.publicKey);
      const createDummyIx = createAssociatedTokenAccountInstruction(wallet!.publicKey, dummyWhaleUsdcAta, dummyWhale.publicKey, USDC_MINT);

      await program.methods.fillSlice()
        .accounts({
          buyer: wallet!.publicKey,
          childSlice: new PublicKey(activeSliceId),
          parent: pdas.parentStatePda,
          vault: pdas.vaultPda,
          buyerTargetAccount: buyerUsdcAta,
          whaleTargetAccount: dummyWhaleUsdcAta,
          buyerSolAccount: buyerWsolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([createDummyIx])
        .rpc();

      logInfo('🤝 SWAP COMPLETE!');
      fetchProtocolState();
      fetchBalances();
    } catch (err: any) { logInfo(`❌ Swap Error: ${err.message}`); }
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