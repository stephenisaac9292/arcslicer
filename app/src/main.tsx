import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import './polyfills';
import App from './App.tsx';
import './index.css';

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';

// This is required to style the default "Connect Wallet" modal!
import '@solana/wallet-adapter-react-ui/styles.css';

const Root = () => {
  // Point the frontend to your local blockchain
  const endpoint = useMemo(() => "http://127.0.0.1:8899", []);
  
  // Empty array automatically detects injected wallets like Phantom
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
