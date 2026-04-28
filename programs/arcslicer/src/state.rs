use anchor_lang::prelude::*;

#[account]
pub struct SlicerParent {
    pub owner: Pubkey,           // The Whale who deposits funds
    pub mint: Pubkey,            // The token being sold 
    pub target_mint: Pubkey,     // The token wanted in return 
    pub vault_pda: Pubkey,       // The escrow account holding the funds
    pub total_deposit: u64,      // The original amount 
    pub remaining_balance: u64,  // Amount left to slice
    pub urgency_level: u8,       // 1 (Stealth), 2 (Standard), 3 (Aggressive)
    pub last_slice_time: i64,    // Timestamp of the last engine trigger
    pub bump: u8,                // PDA bump for this state account
    pub vault_bump: u8,          // PDA bump for the token vault
}

#[account]
pub struct ChildSlice {
    pub parent: Pubkey,          // Links back to the SlicerParent
    pub amount_available: u64,   // The specific chunk for sale
    pub price_per_token: u64,    // The required price for this chunk
    pub is_filled: bool,         // Status flag
}