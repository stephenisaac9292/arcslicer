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
    balances, vaultData, slices, isParentInitialized, isLoading, logs,
    initializeVault, turnCrank, buySlice, refreshState
  } = useArcSlicer();

  const { requestAirdrop, isDropping, faucetLog } = useFaucet();

  const [activeMode, setActiveMode] = useState<'whale' | 'buyer'>('buyer');

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
                  </div>
                </>
              )}

              {activeMode === 'buyer' && (
                <>
                  <section className="shadow-monitor border-green-500/50">
                    <div className="shadow-monitor-head">
                      <h4 className="text-green-400">Available Slices</h4>
                      <button className="refresh-btn" onClick={refreshState} disabled={isLoading}>
                        {isLoading ? 'Syncing...' : 'Sync'}
                      </button>
                    </div>

                    <div className="shadow-grid">
                      <article className="shadow-block">
                        {slices.length === 0 ? <p className="shadow-wait animate-pulse text-gray-500">Scanning pool for active slices...</p> : (
                          <div className="slice-list">
                            {slices.map((slice) => (
                              <div key={slice.id} className="slice-row flex justify-between items-center border-b border-gray-700/50 py-3">
                                <div className="flex flex-col">
                                  <span className="font-bold text-white text-lg">{slice.amount.toFixed(4)} wSOL</span>
                                  <span className="text-xs text-gray-500">Encrypted Dark Pool Route</span>
                                </div>
                                <span className="text-green-400 font-mono bg-green-900/20 px-3 py-1 rounded border border-green-500/30">
                                  {slice.price.toFixed(2)} USDC
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    </div>
                  </section>

                  <div className="action-grid mt-4">
                    <button className="launch-btn bg-green-600 hover:bg-green-500 text-white disabled:opacity-50 w-full" onClick={buySlice} disabled={slices.length === 0}>
                      Buy Best Available Slice <ArrowUpRight size={17} />
                    </button>
                  </div>
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
