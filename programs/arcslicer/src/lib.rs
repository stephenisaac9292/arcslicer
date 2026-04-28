use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
pub mod state;
use state::*;

// Keep YOUR generated ID here.
declare_id!("E6Q35ahMXEsREnpbMzSku4rqDNojGa6iD3XoAVcpSNAQ");

#[program]
pub mod arcslicer {
    use super::*;
    // Instruction handlers will go here
    pub fn initialize_slicer(
        ctx: Context<InitializeSlicer>, 
        total_deposit: u64, 
        urgency_level: u8
    ) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;
        let whale = &ctx.accounts.whale;

        // 1. Initialize the Blueprints
        parent_state.owner = whale.key();
        parent_state.mint = ctx.accounts.mint.key();
        parent_state.target_mint = ctx.accounts.target_mint.key();
        parent_state.vault_pda = ctx.accounts.vault.key();
        parent_state.total_deposit = total_deposit;
        parent_state.remaining_balance = total_deposit;
        parent_state.urgency_level = urgency_level;
        
        let clock = Clock::get()?;
        parent_state.last_slice_time = clock.unix_timestamp;
        
        parent_state.bump = ctx.bumps.parent_state;
        parent_state.vault_bump = ctx.bumps.vault;

        // 2. Execute the CPI (Move the money into the Escrow Vault)
        // FIX 1: Use 'Transfer' directly to clear the unused import warning
        let transfer_accounts = Transfer {
            from: ctx.accounts.whale_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: whale.to_account_info(),
        };
        
        // FIX 2: Anchor 0.30+ expects a Pubkey here, not AccountInfo
        let cpi_program = ctx.accounts.token_program.key(); 
        let cpi_ctx = CpiContext::new(cpi_program, transfer_accounts);
        
        token::transfer(cpi_ctx, total_deposit)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeSlicer<'info> {
    #[account(mut)]
    pub whale: Signer<'info>,

    pub mint: Account<'info, Mint>, // Token being sold
    pub target_mint: Account<'info, Mint>, // Token wanted

    // 1. Create the SlicerParent state account (The Blueprints)
    #[account(
        init,
        payer = whale,
        space = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1 + 1, // Bytes needed
        seeds = [b"parent", whale.key().as_ref()], 
        bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    // 2. Create the PDA Token Vault (The Escrow)
    #[account(
        init,
        payer = whale,
        token::mint = mint,
        token::authority = parent_state, // The program controls this vault
        seeds = [b"vault", parent_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    // The whale's personal token account to deposit from
    #[account(mut)]
    pub whale_token_account: Account<'info, TokenAccount>,

    // Required System Programs
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}



