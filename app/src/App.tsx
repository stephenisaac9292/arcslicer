import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { Activity, ArrowUpRight, Slash } from 'lucide-react';
import { useArcSlicer } from './hooks/useArcSlicer';
import './App.css';

function App() {
  const { publicKey } = useWallet();
  const { 
    balances, vaultData, slices, isParentInitialized, isLoading, logs, 
    initializeVault, turnCrank, buySlice, refreshState 
  } = useArcSlicer();


  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <span className="brand-mark"><Slash size={20} /></span>
          <div><h1 className="brand-name">ArcSlicer</h1></div>
        </div>
        <div className="topbar-controls">
          <WalletMultiButton className="wallet-compact-btn" />
        </div>
      </header>

      <main className="layout">
        <aside className="console-panel" id="security">
          <div className="console-head">
            <span>Execution Console</span>
            <span className="live-pill"><Activity size={14} /> Live</span>
          </div>

          {publicKey ? (
            <div className="session-stack">
              <section className="wallet-map-card">
                <h4>Live Devnet Wallet</h4>
                <dl>
                  <div><dt>Gas (Native SOL)</dt><dd>{balances.nativeSol.toFixed(4)}</dd></div>
                  <div><dt>Trade Asset (USDC)</dt><dd>{balances.usdc.toFixed(2)}</dd></div>
                </dl>
              </section>

              <section className="shadow-monitor">
                <div className="shadow-monitor-head">
                  <h4>Shadow Economy</h4>
                  <button className="refresh-btn" onClick={refreshState} disabled={isLoading}>
                    {isLoading ? 'Syncing...' : 'Sync'}
                  </button>
                </div>

                <div className="shadow-grid">
                  <article className="shadow-block">
                    <p className="shadow-label">ArcSlicer Escrow</p>
                    <p className="shadow-value">{vaultData.lockedSol.toFixed(4)} wSOL</p>
                    <p className="shadow-meta">Slices Pending: {vaultData.slicesRemaining}</p>
                  </article>

                  <article className="shadow-block">
                    <p className="shadow-label">Active Slices</p>
                    {slices.length === 0 ? <p className="shadow-wait">Waiting for crank...</p> : (
                      <div className="slice-list">
                        {slices.map((slice) => (
                          <div key={slice.id} className="slice-row">
                            <span>{slice.amount.toFixed(4)} wSOL</span>
                            <span>{slice.price.toFixed(2)} USDC</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                </div>
              </section>

              <div className="action-grid">
                <button className="launch-btn" onClick={initializeVault}>
                  1: Initialize Vault <ArrowUpRight size={17} />
                </button>
                <button className="launch-btn setup-btn" onClick={turnCrank} disabled={!isParentInitialized}>
                  2: Turn Crank <ArrowUpRight size={17} />
                </button>
                <button className="launch-btn" onClick={buySlice} disabled={!isParentInitialized || slices.length === 0}>
                  3: Buy Slice <ArrowUpRight size={17} />
                </button>
              </div>

              <div className="terminal-log">
                {logs.length === 0 ? 'System ready...' : logs.map((log, i) => <div key={i}>{log}</div>)}
              </div>
            </div>
          ) : (
            <div className="session-card disconnected">
              <h3>Connect Identity</h3>
              <WalletMultiButton className="wallet-main-btn" />
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;