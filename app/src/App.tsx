import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  Activity,
  ArrowUpRight,
  Layers3,
  Route,
  ShieldCheck,
  Slash,
  TimerReset,
} from 'lucide-react';
import './App.css';

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

          {connected ? (
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
                    <dt>Network</dt>
                    <dd>Localnet / Mainnet-ready</dd>
                  </div>
                  <div>
                    <dt>Execution Scope</dt>
                    <dd>Strategy Tier 01</dd>
                  </div>
                </dl>
              </section>

              <section className="risk-card">
                <h4>Guardrails</h4>
                <ul>
                  <li>Max slippage threshold enforced</li>
                  <li>Venue failover routing active</li>
                  <li>Cadence watchdog synchronized</li>
                </ul>
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
