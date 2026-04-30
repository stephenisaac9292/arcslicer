import { useEffect, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  Activity,
  ArrowUpRight,
  Layers3,
  Route,
  ShieldCheck,
  Slash,
  TimerReset,
} from 'lucide-react';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import idl from './idl/arcslicer.json';
import './App.css';

declare global {
  interface Window {
    Buffer: typeof Buffer;
  }
}

if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
}

const telemetry = [
  { label: 'Route Confidence', value: '98.7%', meter: '98%' },
  { label: 'Liquidity Match', value: '94.2%', meter: '94%' },
  { label: 'Cadence Stability', value: '99.1%', meter: '99%' },
];

const DEFAULT_CADENCE_SECONDS = 12;

type MethodCallBuilder = {
  accounts: (accounts: Record<string, PublicKey>) => {
    rpc: () => Promise<string>;
  };
};

type InitializeCall = (totalDeposit: anchor.BN, urgencyLevel: number) => MethodCallBuilder;
type NoArgCall = () => MethodCallBuilder;

type ProgramMethods = {
  initializeSlicer?: InitializeCall;
  initialize_slicer?: InitializeCall;
  engineTriggerSlice?: NoArgCall;
  engine_trigger_slice?: NoArgCall;
  fillSlice?: NoArgCall;
  fill_slice?: NoArgCall;
};

type ParentStateData = {
  remainingBalance?: anchor.BN;
  remaining_balance?: anchor.BN;
  urgencyLevel?: number;
  urgency_level?: number;
  lastSliceTime?: anchor.BN | number;
  last_slice_time?: anchor.BN | number;
};

type ChildSliceData = {
  parent?: PublicKey;
  amountAvailable?: anchor.BN;
  amount_available?: anchor.BN;
  pricePerToken?: anchor.BN;
  price_per_token?: anchor.BN;
  isFilled?: boolean;
  is_filled?: boolean;
};

type ChildSliceRecord = {
  publicKey: PublicKey;
  account: ChildSliceData;
};

type ShadowSlice = {
  id: string;
  amount: number;
  price: number;
};

type SliceFilter = {
  memcmp: {
    offset: number;
    bytes: string;
  };
};

type ProgramAccountsApi = {
  slicerParent?: {
    fetch: (address: PublicKey) => Promise<ParentStateData>;
  };
  slicer_parent?: {
    fetch: (address: PublicKey) => Promise<ParentStateData>;
  };
  childSlice?: {
    all: (filters?: SliceFilter[]) => Promise<ChildSliceRecord[]>;
  };
  child_slice?: {
    all: (filters?: SliceFilter[]) => Promise<ChildSliceRecord[]>;
  };
};

const bnToNumber = (value: anchor.BN | number | undefined): number => {
  if (value === undefined) {
    return 0;
  }

  if (typeof value === 'number') {
    return value;
  }

  return value.toNumber();
};

const urgencyToCadenceSeconds = (urgencyLevel: number): number => {
  if (urgencyLevel === 1) {
    return 24;
  }

  if (urgencyLevel === 3) {
    return 6;
  }

  return DEFAULT_CADENCE_SECONDS;
};

const formatCountdown = (seconds: number | null): string => {
  if (seconds === null) {
    return '--:--';
  }

  if (seconds <= 0) {
    return '00:00';
  }

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

function App() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [logs, setLogs] = useState<string[]>([]);
  const [mintSol, setMintSol] = useState<PublicKey | null>(null);
  const [mintUsdc, setMintUsdc] = useState<PublicKey | null>(null);
  const [vaultData, setVaultData] = useState({
    lockedSol: 0,
    slicesRemaining: 0,
    cadenceSeconds: DEFAULT_CADENCE_SECONDS,
    lastSliceTime: 0,
  });
  const [slices, setSlices] = useState<ShadowSlice[]>([]);
  const [isProtocolLoading, setIsProtocolLoading] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const assetsReady = mintSol !== null && mintUsdc !== null;

  const shortAddress = wallet
    ? `${wallet.publicKey.toBase58().slice(0, 4)}...${wallet.publicKey.toBase58().slice(-4)}`
    : null;
  const nextTradeCountdown = formatCountdown(
    vaultData.lastSliceTime > 0
      ? vaultData.lastSliceTime + vaultData.cadenceSeconds - nowSec
      : null,
  );
  const liveTapeItems = [
    'Spread Integrity: 99.4%',
    `Slice Cadence: ${vaultData.cadenceSeconds}s`,
    'Quote Drift: 0.03%',
    `Pending Slices: ${vaultData.slicesRemaining}`,
  ];

  const shortKey = (key: PublicKey | null) => {
    if (!key) {
      return 'pending';
    }

    const value = key.toBase58();
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  };

  const logInfo = (message: string) => {
    setLogs((prev) => [...prev, message]);
  };

  const getProgram = (): anchor.Program<anchor.Idl> | null => {
    if (!wallet) {
      return null;
    }

    const provider = new anchor.AnchorProvider(connection, wallet, {
      preflightCommitment: 'processed',
    });

    return new anchor.Program(idl as anchor.Idl, provider);
  };

  const runWithAccountsFallback = async (
    builderFactory: () => MethodCallBuilder,
    accountVariants: Record<string, PublicKey>[],
  ) => {
    let lastError: unknown;

    for (const accounts of accountVariants) {
      try {
        return await builderFactory().accounts(accounts).rpc();
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error('All account variants failed.');
  };

  const getParentAndVaultPdas = (program: anchor.Program<anchor.Idl>) => {
    if (!wallet) {
      return null;
    }

    const [parentStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('parent'), wallet.publicKey.toBuffer()],
      program.programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), parentStatePda.toBuffer()],
      program.programId,
    );

    return {
      parentStatePda,
      vaultPda,
    };
  };

  const fetchActiveSlices = async (
    program: anchor.Program<anchor.Idl>,
    parentStatePda: PublicKey,
  ): Promise<ShadowSlice[]> => {
    const accountApi = program.account as unknown as ProgramAccountsApi;
    const childSliceClient = accountApi.childSlice ?? accountApi.child_slice;
    if (!childSliceClient) {
      return [];
    }

    const allSlices = await childSliceClient.all([
      {
        memcmp: {
          offset: 8,
          bytes: parentStatePda.toBase58(),
        },
      },
    ]);

    return allSlices
      .filter((slice) => !(slice.account.isFilled ?? slice.account.is_filled ?? false))
      .map((slice) => {
        const amount = slice.account.amountAvailable ?? slice.account.amount_available;
        const price = slice.account.pricePerToken ?? slice.account.price_per_token;

        return {
          id: slice.publicKey.toBase58(),
          amount: bnToNumber(amount) / 1e9,
          price: bnToNumber(price) / 1e6,
        };
      });
  };

  const fetchProtocolState = async (
    program: anchor.Program<anchor.Idl>,
    parentStatePda: PublicKey,
    vaultPda: PublicKey,
    slicesRemaining: number,
  ) => {
    let lockedSol = 0;
    try {
      const vaultBalance = await connection.getTokenAccountBalance(vaultPda);
      lockedSol = vaultBalance.value.uiAmount ?? Number(vaultBalance.value.uiAmountString ?? '0');
    } catch {
      lockedSol = 0;
    }

    const accountApi = program.account as unknown as ProgramAccountsApi;
    const parentClient = accountApi.slicerParent ?? accountApi.slicer_parent;

    if (!parentClient) {
      setVaultData({
        lockedSol,
        slicesRemaining,
        cadenceSeconds: DEFAULT_CADENCE_SECONDS,
        lastSliceTime: 0,
      });
      return;
    }

    try {
      const state = await parentClient.fetch(parentStatePda);
      const urgencyLevel = state.urgencyLevel ?? state.urgency_level ?? 2;
      const lastSliceTime = bnToNumber(state.lastSliceTime ?? state.last_slice_time);

      setVaultData({
        lockedSol,
        slicesRemaining,
        cadenceSeconds: urgencyToCadenceSeconds(urgencyLevel),
        lastSliceTime,
      });
    } catch {
      setVaultData({
        lockedSol,
        slicesRemaining,
        cadenceSeconds: DEFAULT_CADENCE_SECONDS,
        lastSliceTime: 0,
      });
    }
  };

  const refreshShadowEconomy = async () => {
    if (!wallet) {
      return;
    }

    const program = getProgram();
    if (!program) {
      return;
    }

    const pdas = getParentAndVaultPdas(program);
    if (!pdas) {
      return;
    }

    try {
      setIsProtocolLoading(true);
      const activeSlices = await fetchActiveSlices(program, pdas.parentStatePda);
      setSlices(activeSlices);
      await fetchProtocolState(program, pdas.parentStatePda, pdas.vaultPda, activeSlices.length);
    } catch (error) {
      console.error(error);
    } finally {
      setIsProtocolLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!wallet) {
      setVaultData({
        lockedSol: 0,
        slicesRemaining: 0,
        cadenceSeconds: DEFAULT_CADENCE_SECONDS,
        lastSliceTime: 0,
      });
      setSlices([]);
      return;
    }

    void refreshShadowEconomy();
    const refresh = window.setInterval(() => {
      void refreshShadowEconomy();
    }, 12000);

    return () => window.clearInterval(refresh);
    // Depends on wallet session + minted assets lifecycle.
  }, [wallet, mintSol, mintUsdc]);

  const handleSetupTokens = async () => {
    if (!wallet) {
      logInfo('ERROR: Connect wallet first.');
      return;
    }

    try {
      logInfo('INFO: Building mock assets...');

      const newMintSol = Keypair.generate();
      const newMintUsdc = Keypair.generate();
      const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

      const whaleSolAta = getAssociatedTokenAddressSync(newMintSol.publicKey, wallet.publicKey);
      const whaleUsdcAta = getAssociatedTokenAddressSync(newMintUsdc.publicKey, wallet.publicKey);

      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: newMintSol.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(newMintSol.publicKey, 9, wallet.publicKey, null),
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: newMintUsdc.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(newMintUsdc.publicKey, 6, wallet.publicKey, null),
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          whaleSolAta,
          wallet.publicKey,
          newMintSol.publicKey,
        ),
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          whaleUsdcAta,
          wallet.publicKey,
          newMintUsdc.publicKey,
        ),
        createMintToInstruction(newMintSol.publicKey, whaleSolAta, wallet.publicKey, 1000n * 10n ** 9n),
        createMintToInstruction(
          newMintUsdc.publicKey,
          whaleUsdcAta,
          wallet.publicKey,
          10000n * 10n ** 6n,
        ),
      );

      const latest = await connection.getLatestBlockhash('confirmed');
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = latest.blockhash;

      logInfo('INFO: Confirm transaction in wallet...');
      const signedTx = await wallet.signTransaction(tx);
      signedTx.partialSign(newMintSol, newMintUsdc);

      const signature = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed',
      );

      setMintSol(newMintSol.publicKey);
      setMintUsdc(newMintUsdc.publicKey);
      logInfo('OK: Assets created. You have 1000 mock SOL and 10000 mock USDC.');
      void refreshShadowEconomy();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInfo(`ERROR: Setup failed - ${message}`);
      console.error(error);
    }
  };

  const handleInitialize = async () => {
    const program = getProgram();
    if (!program || !wallet || !mintSol || !mintUsdc) {
      return;
    }

    try {
      logInfo('🔒 Locking 1,000 SOL into ArcSlicer Escrow...');

      const pdas = getParentAndVaultPdas(program);
      if (!pdas) {
        throw new Error('Unable to derive protocol PDAs.');
      }
      const { parentStatePda, vaultPda } = pdas;
      const whaleSolAta = getAssociatedTokenAddressSync(mintSol, wallet.publicKey);

      const methods = program.methods as unknown as ProgramMethods;
      const initialize = methods.initializeSlicer;
      if (!initialize) {
        throw new Error('initializeSlicer method not found in IDL.');
      }

      await initialize(new anchor.BN(1000 * 10 ** 9), 2)
        .accounts({
          whale: wallet.publicKey,
          mint: mintSol,
          targetMint: mintUsdc,
          parentState: parentStatePda,
          vault: vaultPda,
          whaleTokenAccount: whaleSolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      logInfo('✅ Vault Initialized! Ready for the engine.');
      void refreshShadowEconomy();
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      logInfo(`❌ Vault Error: ${message}`);
    }
  };

  const handleTurnCrank = async () => {
    if (!wallet) {
      logInfo('ERROR: Connect wallet first.');
      return;
    }

    const program = getProgram();
    if (!program) {
      logInfo('ERROR: Program not available.');
      return;
    }

    try {
      logInfo('INFO: Cranking engine...');

      const pdas = getParentAndVaultPdas(program);
      if (!pdas) {
        throw new Error('Unable to derive protocol PDAs.');
      }
      const { parentStatePda } = pdas;

      const accountApi = program.account as unknown as ProgramAccountsApi;
      const parentClient = accountApi.slicerParent ?? accountApi.slicer_parent;
      if (!parentClient) {
        throw new Error('SlicerParent account client unavailable.');
      }

      const parentData = await parentClient.fetch(parentStatePda);
      const balance = parentData.remainingBalance ?? parentData.remaining_balance;
      if (!balance) {
        throw new Error('remaining_balance not found on parent state.');
      }

      const [childSlicePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('slice'), parentStatePda.toBuffer(), balance.toArrayLike(Buffer, 'le', 8)],
        program.programId,
      );

      const methods = program.methods as unknown as ProgramMethods;
      const crank = methods.engineTriggerSlice ?? methods.engine_trigger_slice;
      if (!crank) {
        throw new Error('engine_trigger_slice method not found in IDL.');
      }

      await runWithAccountsFallback(
        () => crank(),
        [
          {
            cranker: wallet.publicKey,
            parentState: parentStatePda,
            childSlice: childSlicePda,
            systemProgram: SystemProgram.programId,
          },
          {
            cranker: wallet.publicKey,
            parent_state: parentStatePda,
            child_slice: childSlicePda,
            system_program: SystemProgram.programId,
          },
        ],
      );

      logInfo('OK: Crank turned. New slice created.');
      void refreshShadowEconomy();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInfo(`ERROR: Crank failed - ${message}`);
      console.error(error);
    }
  };

  const handleBuySlice = async () => {
    const program = getProgram();
    if (!program || !wallet || !mintSol || !mintUsdc) return;

    try {
      logInfo('🛒 Attempting to purchase active slice...');
      const pdas = getParentAndVaultPdas(program);
      if (!pdas) {
        throw new Error('Unable to derive protocol PDAs.');
      }
      const { parentStatePda, vaultPda } = pdas;

      const accountApi = program.account as unknown as ProgramAccountsApi;
      const childSliceClient = accountApi.childSlice ?? accountApi.child_slice;
      if (!childSliceClient) {
        throw new Error('ChildSlice account client unavailable.');
      }

      const allSlices = await childSliceClient.all([
        {
          memcmp: {
            offset: 8,
            bytes: parentStatePda.toBase58(),
          },
        },
      ]);
      const activeSlice = allSlices.find(
        (slice: ChildSliceRecord) => !(slice.account.isFilled ?? slice.account.is_filled ?? false),
      );

      if (!activeSlice || !activeSlice.publicKey) {
        logInfo('❌ No active slices found. Turn the crank first!');
        return;
      }

      logInfo(`🎯 Found Slice: ${activeSlice.publicKey.toBase58().slice(0, 8)}...`);

      const buyerSolAta = getAssociatedTokenAddressSync(mintSol, wallet.publicKey);
      const buyerUsdcAta = getAssociatedTokenAddressSync(mintUsdc, wallet.publicKey);

      // THE FIX: Generate a dummy destination account for the Whale to receive the USDC
      const dummyWhale = Keypair.generate();
      const dummyWhaleUsdcAta = getAssociatedTokenAddressSync(mintUsdc, dummyWhale.publicKey);

      // Instruction to actually create that dummy account on the blockchain
      const createDummyAtaIx = createAssociatedTokenAccountInstruction(
        wallet.publicKey, // You pay the tiny creation fee
        dummyWhaleUsdcAta,
        dummyWhale.publicKey,
        mintUsdc,
      );

      // Execute the swap, but prepend the creation instruction!
      await program.methods
        .fillSlice()
        .accounts({
          buyer: wallet.publicKey,
          childSlice: activeSlice.publicKey,
          parent: parentStatePda,
          vault: vaultPda,
          buyerTargetAccount: buyerUsdcAta,
          whaleTargetAccount: dummyWhaleUsdcAta, // 👈 Different account now!
          buyerSolAccount: buyerSolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([createDummyAtaIx]) // 👈 Creates the account right before the swap
        .rpc();

      logInfo('🤝 SWAP COMPLETE! Mock USDC paid, SOL received.');
      void refreshShadowEconomy();
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      logInfo(`❌ Swap Error: ${message}`);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <span className="brand-mark" aria-hidden="true">
            <Slash size={20} strokeWidth={2.2} />
          </span>
          <div>
            <p className="brand-kicker">Execution Intelligence Layer</p>
            <h1 className="brand-name">ArcSlicer</h1>
          </div>
        </div>

        <nav className="nav-links" aria-label="Primary">
          <a href="#architecture">Architecture</a>
          <a href="#security">Security</a>
          <a href="#docs">Docs</a>
        </nav>

        <div className="topbar-controls">
          <span className="chain-chip">
            <Activity size={12} />
            Solana Ready
          </span>
          <WalletMultiButton className="wallet-compact-btn" />
        </div>
      </header>

      <main className="layout">
        <section className="hero-panel">
          <p className="eyebrow">TWAP Orchestration For Size-Sensitive Flow</p>
          <h2>Execute Size Like a Discipline, Not a Guess.</h2>
          <p className="hero-copy">
            ArcSlicer coordinates deterministic TWAP schedules across Solana venues,
            preserving intent through guardrails, venue-aware routing, and cadence
            precision built for professional execution desks.
          </p>

          <div className="hero-actions">
            <WalletMultiButton className="wallet-main-btn" />
            <a href="#architecture" className="ghost-link">
              Inspect Architecture
              <ArrowUpRight size={16} />
            </a>
          </div>

          <div className="tape-rail" aria-label="Execution tape">
            {liveTapeItems.map((item) => (
              <span key={item} className="tape-item">
                {item}
              </span>
            ))}
          </div>

          <div className="ops-grid" aria-label="Execution telemetry">
            {telemetry.map((item) => (
              <article className="metric-card" key={item.label}>
                <div className="metric-head">
                  <p>{item.label}</p>
                  <strong>{item.value}</strong>
                </div>
                <span className="meter-track" aria-hidden="true">
                  <span className="meter-fill" style={{ width: item.meter }} />
                </span>
              </article>
            ))}
          </div>
        </section>

        <aside className="console-panel" id="security">
          <div className="console-head">
            <span>Execution Console</span>
            <span className="live-pill">
              <Activity size={14} />
              Live
            </span>
          </div>

          {wallet ? (
            <div className="session-stack">
              <section className="session-card">
                <h3>Wallet Linked</h3>
                <p>Identity is verified. Session controls and execution policy are active.</p>
                <dl>
                  <div>
                    <dt>Wallet</dt>
                    <dd>{shortAddress}</dd>
                  </div>
                  <div>
                    <dt>Mock SOL Mint</dt>
                    <dd>{shortKey(mintSol)}</dd>
                  </div>
                  <div>
                    <dt>Mock USDC Mint</dt>
                    <dd>{shortKey(mintUsdc)}</dd>
                  </div>
                </dl>
              </section>

              <section className="risk-card">
                <h4>Runbook</h4>
                <ul>
                  <li>Step 1 mints mock SOL + mock USDC for local execution tests</li>
                  <li>Step 2 initializes parent state and escrow vault accounts</li>
                  <li>Step 3 triggers a fresh child slice, Step 4 purchases it</li>
                </ul>
              </section>

              <section className="shadow-monitor">
                <div className="shadow-monitor-head">
                  <h4>Shadow Economy</h4>
                  <button
                    className="refresh-btn"
                    type="button"
                    onClick={() => void refreshShadowEconomy()}
                    disabled={isProtocolLoading}
                  >
                    {isProtocolLoading ? 'Syncing...' : 'Sync'}
                  </button>
                </div>

                <div className="shadow-grid">
                  <article className="shadow-block">
                    <p className="shadow-label">ArcSlicer Escrow</p>
                    <p className="shadow-value">{vaultData.lockedSol.toFixed(4)} SOL</p>
                    <p className="shadow-meta">Total Slices Pending: {vaultData.slicesRemaining}</p>
                    <p className="shadow-meta">Next Trade In: {nextTradeCountdown}</p>
                  </article>

                  <article className="shadow-block">
                    <p className="shadow-label">Active Slices</p>
                    {slices.length === 0 ? (
                      <p className="shadow-wait">
                        {isProtocolLoading ? 'Reading chain state...' : 'Waiting for crank...'}
                      </p>
                    ) : (
                      <div className="slice-list">
                        {slices.map((slice) => (
                          <div key={slice.id} className="slice-row">
                            <span>{slice.amount.toFixed(4)} SOL</span>
                            <span>{slice.price.toFixed(2)} USDC</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                </div>
              </section>

              <div className="action-grid">
                <button
                  className="launch-btn setup-btn"
                  type="button"
                  onClick={handleSetupTokens}
                  disabled={assetsReady}
                >
                  Step 1: Mint Mock Assets
                  <ArrowUpRight size={17} />
                </button>

                <button
                  className="launch-btn"
                  type="button"
                  onClick={handleInitialize}
                  disabled={!assetsReady}
                >
                  Step 2: Initialize Vault
                  <ArrowUpRight size={17} />
                </button>

                <button
                  className="launch-btn setup-btn"
                  type="button"
                  onClick={handleTurnCrank}
                  disabled={!assetsReady}
                >
                  Step 3: Turn Crank
                  <ArrowUpRight size={17} />
                </button>

                <button
                  className="launch-btn"
                  type="button"
                  onClick={handleBuySlice}
                  disabled={!assetsReady}
                >
                  Step 4: Buy Slice
                  <ArrowUpRight size={17} />
                </button>
              </div>

              <div className="terminal-log" role="log" aria-live="polite">
                {logs.length === 0
                  ? 'System ready...'
                  : logs.map((log, index) => <div key={`${log}-${index}`}>{log}</div>)}
              </div>
            </div>
          ) : (
            <div className="session-stack">
              <section className="session-card disconnected">
                <h3>Connect Identity</h3>
                <p>
                  Attach a wallet to create authenticated execution sessions and route
                  schedule-managed orders through guarded infrastructure.
                </p>
                <ul className="disconnected-points">
                  <li>Session-level policy controls</li>
                  <li>Execution telemetry visibility</li>
                  <li>On-chain submission permissions</li>
                </ul>
                <WalletMultiButton className="wallet-main-btn" />
              </section>
            </div>
          )}
        </aside>
      </main>

      <section className="feature-band" id="architecture">
        <article className="feature-card">
          <span className="feature-index">01</span>
          <div className="feature-head">
            <Layers3 size={18} />
            <h3>Liquidity Topology</h3>
          </div>
          <p>
            Continuously ranks venues by depth, volatility, and cost so each child order
            lands where fill quality is highest.
          </p>
        </article>

        <article className="feature-card">
          <span className="feature-index">02</span>
          <div className="feature-head">
            <Route size={18} />
            <h3>Adaptive Routing</h3>
          </div>
          <p>
            Switches route plans in real time as liquidity shifts, while preserving the
            parent order objective and timing discipline.
          </p>
        </article>

        <article className="feature-card">
          <span className="feature-index">03</span>
          <div className="feature-head">
            <TimerReset size={18} />
            <h3>Deterministic Cadence</h3>
          </div>
          <p>
            Maintains strict interval execution with fallback logic to protect schedule
            integrity through latency bursts.
          </p>
        </article>

        <article className="feature-card">
          <span className="feature-index">04</span>
          <div className="feature-head">
            <ShieldCheck size={18} />
            <h3>Risk Containment</h3>
          </div>
          <p>
            Hard slippage bounds and strategy gates validate every submission before it
            hits chain.
          </p>
        </article>
      </section>

      <footer className="site-footer" id="docs">
        <p>© {new Date().getFullYear()} ArcSlicer Protocol</p>
        <div className="footer-links">
          <a href="#">Docs</a>
          <a href="#">Status</a>
          <a href="#">X / Twitter</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
