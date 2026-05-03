import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import './polyfills';
import App from './App.tsx';
import './index.css';

// Import the clusterApiUrl helper
import { clusterApiUrl } from '@solana/web3.js'; 

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';

import '@solana/wallet-adapter-react-ui/styles.css';

const Root = () => {
  // THE FIX: Pull your private RPC URL from .env, fallback to public devnet if missing
  const endpoint = useMemo(() => import.meta.env.VITE_RPC_URL || clusterApiUrl('devnet'), []);
  
  const wallets = useMemo(() => [], []); 

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);