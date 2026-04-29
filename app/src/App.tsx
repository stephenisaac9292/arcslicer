import { useState } from 'react';
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
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
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

if (typeof window !== 'undefined' && !window.Buffer) {
  window.Buffer = Buffer;
}

const tapeItems = [
  'Spread Integrity: 99.4%',
  'Slice Cadence: 12s',
  'Quote Drift: 0.03%',
  'Pending Slices: 12',
];

const telemetry = [
  { label: 'Route Confidence', value: '98.7%', meter: '98%' },
  { label: 'Liquidity Match', value: '94.2%', meter: '94%' },
  { label: 'Cadence Stability', value: '99.1%', meter: '99%' },
];

type InitializeCall = (totalDeposit: anchor.BN, urgencyLevel: number) => {
  accounts: (accounts: Record<string, PublicKey>) => {
    rpc: () => Promise<string>;
  };
};

type ProgramMethods = {
  initializeSlicer?: InitializeCall;
  initialize_slicer?: InitializeCall;
};

function App() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [logs, setLogs] = useState<string[]>([]);
  const [mintSol, setMintSol] = useState<PublicKey | null>(null);
  const [mintUsdc, setMintUsdc] = useState<PublicKey | null>(null);

  const assetsReady = mintSol !== null && mintUsdc !== null;

  const shortAddress = wallet
    ? `${wallet.publicKey.toBase58().slice(0, 4)}...${wallet.publicKey.toBase58().slice(-4)}`
    : null;

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

  const handleSetupTokens = async () => {
    if (!wallet) {
      logInfo('ERROR: Connect wallet first.');
      return;
    }

    try {
      logInfo('INFO: Building atomic setup transaction...');

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
      logInfo('OK: Mock assets created. 1000 mock SOL minted.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInfo(`ERROR: Setup failed - ${message}`);
      console.error(error);
    }
  };

  const handleInitialize = async () => {
    if (!wallet || !mintSol || !mintUsdc) {
      logInfo('ERROR: Run Step 1 first to create mock assets.');
      return;
    }

    const program = getProgram();
    if (!program) {
      logInfo('ERROR: Program not available.');
      return;
    }

    try {
      logInfo('INFO: Initializing vault with 1000 mock SOL...');

      const [parentStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('parent'), wallet.publicKey.toBuffer()],
        program.programId,
      );

      const whaleSolAta = getAssociatedTokenAddressSync(mintSol, wallet.publicKey);
      const totalDeposit = new anchor.BN(1000).mul(new anchor.BN(10).pow(new anchor.BN(9)));
      const urgencyLevel = 2;

      const methods = program.methods as unknown as ProgramMethods;
      const initialize = methods.initializeSlicer ?? methods.initialize_slicer;

      if (!initialize) {
        throw new Error('initialize_slicer method not found in IDL.');
      }

      const tx = await initialize(totalDeposit, urgencyLevel)
        .accounts({
          whale: wallet.publicKey,
          mint: mintSol,
          targetMint: mintUsdc,
          target_mint: mintUsdc,
          parentState: parentStatePda,
          parent_state: parentStatePda,
          whaleTokenAccount: whaleSolAta,
          whale_token_account: whaleSolAta,
        })
        .rpc();

      logInfo(`OK: Vault initialized. Tx: ${tx.slice(0, 15)}...`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInfo(`ERROR: Vault init failed - ${message}`);
      console.error(error);
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
            {tapeItems.map((item) => (
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
                  <li>Step 1 creates mock SOL and USDC mints + whale token accounts</li>
                  <li>Step 2 initializes ArcSlicer with the generated mint accounts</li>
                  <li>Logs below show every transaction stage and errors</li>
                </ul>
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
