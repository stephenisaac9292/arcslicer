import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Arcslicer } from "../../../target/types/arcslicer";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { expect } from "chai";

describe("ArcSlicer Escrow Testing", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Arcslicer as Program<Arcslicer>;

  // 1. Define our actors and assets
  const whale = anchor.web3.Keypair.generate();
  let mintSol: anchor.web3.PublicKey;    // The asset to sell
  let mintUsdc: anchor.web3.PublicKey;   // The asset wanted
  let whaleSolAta: anchor.web3.PublicKey;// Whale's wallet holding the asset

  // 2. Define the PDAs
  let parentStatePda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  // 3. Test Constants
  const TOTAL_DEPOSIT = new anchor.BN(1000 * 10 ** 9); // 1000 Tokens (accounting for decimals)
  const URGENCY_LEVEL = 2; // Standard

  before(async () => {
    // Airdrop raw SOL for transaction fees
    const sig = await provider.connection.requestAirdrop(whale.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    // Create Mock Mints (Fake SOL and Fake USDC)
    mintSol = await createMint(provider.connection, whale, whale.publicKey, null, 9);
    mintUsdc = await createMint(provider.connection, whale, whale.publicKey, null, 6);

    // Create the Whale's token account and mint 1,000 tokens to it
    const whaleAta = await getOrCreateAssociatedTokenAccount(provider.connection, whale, mintSol, whale.publicKey);
    whaleSolAta = whaleAta.address;
    await mintTo(provider.connection, whale, mintSol, whaleSolAta, whale, TOTAL_DEPOSIT.toNumber());

    // Derive the PDAs exactly how the Rust code does
    [parentStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("parent"), whale.publicKey.toBuffer()],
      program.programId
    );
    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), parentStatePda.toBuffer()],
      program.programId
    );
  });

  it("Successfully initializes the Escrow Vault!", async () => {
    // Trigger your smart contract instruction
    await program.methods
      .initializeSlicer(TOTAL_DEPOSIT, URGENCY_LEVEL)
      .accounts({
        whale: whale.publicKey,
        mint: mintSol,
        targetMint: mintUsdc,
        whaleTokenAccount: whaleSolAta,
        // Anchor auto-resolves parentState, vault, tokenProgram, systemProgram, and rent.
      })
      .signers([whale])
      .rpc();

    // -- ASSERTIONS -- //

    // 1. Did the state save correctly?
    const parentAccount = await program.account.slicerParent.fetch(parentStatePda);
    expect(parentAccount.totalDeposit.toString()).to.equal(TOTAL_DEPOSIT.toString());
    expect(parentAccount.urgencyLevel).to.equal(URGENCY_LEVEL);
    expect(parentAccount.owner.toBase58()).to.equal(whale.publicKey.toBase58());

    // 2. Did the money actually move into the PDA vault?
    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(vaultAccount.amount.toString()).to.equal(TOTAL_DEPOSIT.toString());
    
    console.log(`✅ Escrow verified! Locked ${vaultAccount.amount.toString()} tokens in the PDA.`);
  });


  it("Successfully cranks the engine and generates a jittered slice!", async () => {
    // 1. Read the state BEFORE the crank to get the exact seed
    const parentBefore = await program.account.slicerParent.fetch(parentStatePda);
    const balanceBefore = parentBefore.remainingBalance;

    // 2. Derive the Child Slice PDA using TypeScript (Matching Rust's to_le_bytes)
    const [childSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("slice"),
        parentStatePda.toBuffer(),
        balanceBefore.toArrayLike(Buffer, "le", 8), // Converts the u64 to Little Endian bytes!
      ],
      program.programId
    );

    // 3. Create a random "Keeper" bot to turn the crank
    const cranker = anchor.web3.Keypair.generate();
    
    // Airdrop some gas to the bot so they can pay the rent for the new ChildSlice account
    const sig = await provider.connection.requestAirdrop(cranker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    // 4. Turn the Crank
    await program.methods
      .engineTriggerSlice()
      .accountsPartial({
        cranker: cranker.publicKey,
        parentState: parentStatePda,
        childSlice: childSlicePda,
      })
      .signers([cranker])
      .rpc();

    // -- ASSERTIONS -- //

    // Fetch the updated Parent Vault and the newly born Child Slice
    const parentAfter = await program.account.slicerParent.fetch(parentStatePda);
    const newChild = await program.account.childSlice.fetch(childSlicePda);

    // Verify the balance went down
    expect(parentAfter.remainingBalance.toNumber()).to.be.lessThan(balanceBefore.toNumber());
    
    console.log(`\n    ⚙️  Engine Cranked!`);
    console.log(`    🔪 Jittered Slice Size: ${newChild.amountAvailable.toString()}`);
    console.log(`    📉 Remaining Vault Balance: ${parentAfter.remainingBalance.toString()}`);
  });

  it("Successfully fills the slice (Atomic Swap)!", async () => {
    // 1. Fetch the Child Slice we created in the last test
    // We use .all() to grab the active slice floating on the network
    const activeSlices = await program.account.childSlice.all();
    const targetSlice = activeSlices[0]; 
    const childSlicePda = targetSlice.publicKey;
    const sliceData = targetSlice.account;

    // Calculate the expected USDC cost
    const costInUsdc = Math.floor((sliceData.amountAvailable.toNumber() * sliceData.pricePerToken.toNumber()) / 1_000_000_000);

    // 2. Setup the Buyer
    const buyer = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(buyer.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    // 3. Create Token Accounts for the Swap
    // Buyer needs Mock USDC to pay, and a Mock SOL account to receive
    const buyerUsdcAta = await getOrCreateAssociatedTokenAccount(provider.connection, buyer, mintUsdc, buyer.publicKey);
    const buyerSolAta = await getOrCreateAssociatedTokenAccount(provider.connection, buyer, mintSol, buyer.publicKey);
    
    // Whale needs a Mock USDC account to receive the payment
    const whaleUsdcAta = await getOrCreateAssociatedTokenAccount(provider.connection, whale, mintUsdc, whale.publicKey);

    // Mint some starting USDC to the Buyer so they can afford the trade
    await mintTo(provider.connection, buyer, mintUsdc, buyerUsdcAta.address, whale, costInUsdc * 2);

    // 4. Execute the Atomic Swap
    await program.methods
      .fillSlice()
      .accounts({
        buyer: buyer.publicKey,
        childSlice: childSlicePda,
        parent: parentStatePda,
        vault: vaultPda,
        buyerTargetAccount: buyerUsdcAta.address,
        whaleTargetAccount: whaleUsdcAta.address,
        buyerSolAccount: buyerSolAta.address,
        // tokenProgram is auto-resolved
      })
      .signers([buyer])
      .rpc();

    // -- ASSERTIONS -- //
    
    // Check the Buyer received the SOL
    const finalBuyerSol = await getAccount(provider.connection, buyerSolAta.address);
    expect(finalBuyerSol.amount.toString()).to.equal(sliceData.amountAvailable.toString());

    // Check the Whale received the USDC
    const finalWhaleUsdc = await getAccount(provider.connection, whaleUsdcAta.address);
    expect(finalWhaleUsdc.amount.toString()).to.equal(costInUsdc.toString());

    // Check the slice is marked as filled
    const filledSlice = await program.account.childSlice.fetch(childSlicePda);
    expect(filledSlice.isFilled).to.be.true;

    console.log(`\n    🤝 Swap Complete!`);
    console.log(`    💰 Buyer paid: ${costInUsdc} USDC`);
    console.log(`    💎 Buyer received: ${finalBuyerSol.amount.toString()} SOL`);
  });
});