import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { Activity, ArrowUpRight, Layers3, ShieldCheck, Slash, TimerReset } from 'lucide-react';
import './App.css';

function App() {
  const { connected, publicKey } = useWallet();
  const shortAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <span className="brand-mark" aria-hidden="true">
            <Slash size={20} strokeWidth={2.2} />
          </span>
          <div>
            <p className="brand-kicker">Solana Execution Layer</p>
            <h1 className="brand-name">ArcSlicer</h1>
          </div>
        </div>

        <nav className="nav-links" aria-label="Primary">
          <a href="#architecture">Architecture</a>
          <a href="#security">Security</a>
          <a href="#docs">Docs</a>
        </nav>

        <WalletMultiButton className="wallet-compact-btn" />
      </header>

      <main className="layout">
        <section className="hero-panel">
          <p className="eyebrow">TWAP Orchestration For Size-Sensitive Flow</p>
          <h2>Slice Large Orders Without Distorting the Tape.</h2>
          <p className="hero-copy">
            ArcSlicer executes deterministic TWAP schedules across Solana liquidity venues,
            balancing fill quality, speed, and slippage control for desks that cannot
            tolerate noisy execution.
          </p>

          <div className="hero-actions">
            <WalletMultiButton className="wallet-main-btn" />
            <a href="#architecture" className="ghost-link">
              View Architecture
              <ArrowUpRight size={16} />
            </a>
          </div>

          <div className="stats-grid" aria-label="Protocol highlights">
            <article className="stat-card">
              <p>Average Slippage Control</p>
              <h3>&lt;0.05%</h3>
            </article>
            <article className="stat-card">
              <p>Execution Determinism</p>
              <h3>99.9%</h3>
            </article>
            <article className="stat-card">
              <p>Settlement Speed</p>
              <h3>&lt;400ms</h3>
            </article>
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

          {connected ? (
            <div className="session-stack">
              <section className="session-card">
                <h3>Wallet Linked</h3>
                <p>Identity confirmed. Session privileges and strategy controls are enabled.</p>
                <dl>
                  <div>
                    <dt>Wallet</dt>
                    <dd>{shortAddress}</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>Localnet / Mainnet-ready</dd>
                  </div>
                  <div>
                    <dt>Risk Engine</dt>
                    <dd>Adaptive guardrails active</dd>
                  </div>
                </dl>
              </section>

              <button className="launch-btn" type="button">
                Launch TWAP Session
                <ArrowUpRight size={17} />
              </button>
            </div>
          ) : (
            <div className="session-stack">
              <section className="session-card disconnected">
                <h3>Connect Identity</h3>
                <p>
                  Attach a wallet to create authenticated execution sessions and
                  route schedule-managed orders.
                </p>
                <WalletMultiButton className="wallet-main-btn" />
              </section>
            </div>
          )}
        </aside>
      </main>

      <section className="feature-band" id="architecture">
        <article className="feature-card">
          <div className="feature-head">
            <Layers3 size={18} />
            <h3>Multi-Venue Routing</h3>
          </div>
          <p>
            Splits parent orders into venue-aware child slices based on liquidity depth,
            quote stability, and execution cost.
          </p>
        </article>

        <article className="feature-card">
          <div className="feature-head">
            <TimerReset size={18} />
            <h3>Deterministic Scheduling</h3>
          </div>
          <p>
            Enforces strict interval timing with fallback logic to preserve cadence through
            network turbulence and transient latency.
          </p>
        </article>

        <article className="feature-card">
          <div className="feature-head">
            <ShieldCheck size={18} />
            <h3>Execution Safeguards</h3>
          </div>
          <p>
            Parameterized slippage thresholds and circuit breakers protect strategy intent
            before every on-chain submission.
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
