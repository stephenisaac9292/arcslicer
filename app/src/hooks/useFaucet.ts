import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Keypair, Transaction, LAMPORTS_PER_SOL, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { 
  createAssociatedTokenAccountInstruction, 
  getAssociatedTokenAddressSync, 
  createMintToInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT
} from '@solana/spl-token';
import { USDC_MINT } from '../config/constants';

export const useFaucet = () => {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [isDropping, setIsDropping] = useState(false);
  const [faucetLog, setFaucetLog] = useState<string>('');

  const requestAirdrop = async () => {
    if (!publicKey) return setFaucetLog('Connect wallet first.');
    setIsDropping(true);
    setFaucetLog('Bypassing public faucet. Booting God Key...');

    try {
      const secretKeyString = import.meta.env.VITE_FAUCET_SECRET_KEY;
      if (!secretKeyString) throw new Error("Faucet Secret Key missing in .env");
      
      const secretKeyArray = Uint8Array.from(JSON.parse(secretKeyString));
      const funderKeypair = Keypair.fromSecretKey(secretKeyArray);

      setFaucetLog('Packaging Gas, wSOL, and USDC...');
      const tx = new Transaction();

      // ==========================================
      // PART 1: SEND NATIVE GAS (0.2 SOL)
      // ==========================================
      tx.add(
        SystemProgram.transfer({
          fromPubkey: funderKeypair.publicKey,
          toPubkey: publicKey,
          lamports: 0.2 * LAMPORTS_PER_SOL,
        })
      );

      // ==========================================
      // PART 2: PRINT THE USDC (10,000)
      // ==========================================
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
      const usdcAtaInfo = await connection.getAccountInfo(userUsdcAta);
      
      if (!usdcAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            funderKeypair.publicKey, // God Key pays the rent to create the bucket
            userUsdcAta, 
            publicKey, // User owns the bucket
            USDC_MINT
          )
        );
      }

      tx.add(
        createMintToInstruction(
          USDC_MINT, userUsdcAta, funderKeypair.publicKey, 10000 * 1_000_000
        )
      );

      // ==========================================
      // PART 3: WRAP THE SOL (0.5 wSOL)
      // ==========================================
      const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey);
      const wsolAtaInfo = await connection.getAccountInfo(userWsolAta);

      if (!wsolAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            funderKeypair.publicKey, // God Key pays the rent
            userWsolAta, 
            publicKey, // User owns the bucket
            NATIVE_MINT
          )
        );
      }

      // Move 0.5 SOL from God Key directly into the User's wSOL bucket
      tx.add(
        SystemProgram.transfer({
          fromPubkey: funderKeypair.publicKey,
          toPubkey: userWsolAta,
          lamports: 0.5 * LAMPORTS_PER_SOL,
        })
      );

      // Officially "wrap" it
      tx.add(createSyncNativeInstruction(userWsolAta));

      // ==========================================
      // EXECUTE (SILENTLY)
      // ==========================================
      setFaucetLog('Executing silent delivery...');
      
      // Because the God Key is doing everything, we don't ask the User's Phantom to sign!
      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [funderKeypair] // Only the God Key signs
      );

      setFaucetLog(`✅ Delivery Complete! Signature: ${signature.slice(0, 8)}...`);

    } catch (error: any) {
      console.error(error);
      setFaucetLog(`❌ Faucet Failed: ${error.message}`);
    } finally {
      setIsDropping(false);
    }
  };

  return { requestAirdrop, isDropping, faucetLog };
};