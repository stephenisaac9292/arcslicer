use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
pub mod state;
use state::*;

// Keep YOUR generated ID here.
declare_id!("75uhE7ybcaxboCBGC7j7hAX9N6oqY1PvearcyULUqxKi");

#[program]
pub mod arcslicer {
    use super::*;

    pub fn initialize_slicer(
        ctx: Context<InitializeSlicer>, 
        total_deposit: u64, 
        urgency_level: u8
    ) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;
        let whale = &ctx.accounts.whale;

        parent_state.owner = whale.key();
        parent_state.mint = ctx.accounts.wsol_mint.key();
        parent_state.target_mint = ctx.accounts.usdc_mint.key();
        parent_state.vault_pda = ctx.accounts.vault.key();
        parent_state.total_deposit = total_deposit;
        parent_state.remaining_balance = total_deposit;
        parent_state.urgency_level = urgency_level;
        
        let clock = Clock::get()?;
        parent_state.last_slice_time = clock.unix_timestamp;
        
        // Removed vault_bump because ATAs do not generate a custom bump in ctx
        parent_state.bump = ctx.bumps.parent_state;

        let transfer_accounts = Transfer {
            from: ctx.accounts.whale_wsol_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: whale.to_account_info(),
        };
        
        // FIX: Anchor 0.30+ uses .key() for CPI program IDs
        let cpi_program = ctx.accounts.token_program.key(); 
        let cpi_ctx = CpiContext::new(cpi_program, transfer_accounts);
        
        token::transfer(cpi_ctx, total_deposit)?;

        Ok(())
    }

    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;

        parent_state.total_deposit = parent_state.total_deposit.checked_add(amount).unwrap();
        parent_state.remaining_balance = parent_state.remaining_balance.checked_add(amount).unwrap();

        let transfer_accounts = Transfer {
            from: ctx.accounts.whale_wsol_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.whale.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.key();
        let cpi_ctx = CpiContext::new(cpi_program, transfer_accounts);

        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn engine_trigger_slice(ctx: Context<TriggerEngine>, current_price: u64) -> Result<()> {
        let parent_state = &mut ctx.accounts.parent_state;
        let child_slice = &mut ctx.accounts.child_slice;
        
        require!(parent_state.remaining_balance > 0, SlicerError::VaultEmpty);

        let clock = Clock::get()?;

        let base_chunk = parent_state.total_deposit / 20; 
        let jitter = (clock.unix_timestamp as u64) % (base_chunk / 2);
        let mut slice_size = base_chunk + jitter;

        if slice_size > parent_state.remaining_balance {
            slice_size = parent_state.remaining_balance;
        }

        parent_state.remaining_balance = parent_state.remaining_balance.checked_sub(slice_size).unwrap();
        parent_state.last_slice_time = clock.unix_timestamp;

        child_slice.parent = parent_state.key();
        child_slice.amount_available = slice_size;
        child_slice.price_per_token = current_price; 
        child_slice.is_filled = false;

        Ok(())
    }

    pub fn fill_slice(ctx: Context<FillSlice>) -> Result<()> {
        let child_slice = &mut ctx.accounts.child_slice;
        let parent = &ctx.accounts.parent;

        require!(!child_slice.is_filled, SlicerError::SliceAlreadyFilled);

        let cost_in_usdc = (child_slice.amount_available as u128)
            .checked_mul(child_slice.price_per_token as u128)
            .unwrap()
            .checked_div(1_000_000_000)
            .unwrap() as u64;

        let cpi_program = ctx.accounts.token_program.key();

        // MEMORY SCOPE 1: Execute USDC Transfer and immediately clear stack
        {
            let usdc_transfer = Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.whale_usdc_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            };
            let cpi_usdc_ctx = CpiContext::new(cpi_program, usdc_transfer);
            token::transfer(cpi_usdc_ctx, cost_in_usdc)?;
        }

        // MEMORY SCOPE 2: Execute wSOL Transfer and immediately clear stack
        {
            let owner_key = parent.owner;
            let parent_bump = parent.bump;
            let parent_seeds = &[
                b"parent",
                owner_key.as_ref(),
                &[parent_bump],
            ];
            let signer = &[&parent_seeds[..]];

            let sol_transfer = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.buyer_wsol_account.to_account_info(),
                authority: parent.to_account_info(),
            };
            let cpi_sol_ctx = CpiContext::new_with_signer(cpi_program, sol_transfer, signer);
            token::transfer(cpi_sol_ctx, child_slice.amount_available)?;
        }

        child_slice.is_filled = true;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeSlicer<'info> {
    #[account(mut)]
    pub whale: Signer<'info>,

    pub wsol_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = whale,
        space = 8 + 200, 
        seeds = [b"parent", whale.key().as_ref()],
        bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    #[account(
        init,
        payer = whale,
        associated_token::mint = wsol_mint,
        associated_token::authority = parent_state, 
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = whale,
    )]
    pub whale_wsol_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub whale: Signer<'info>,

    #[account(
        mut,
        seeds = [b"parent", whale.key().as_ref()],
        bump = parent_state.bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    #[account(
        mut,
        associated_token::mint = parent_state.mint,
        associated_token::authority = parent_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = parent_state.mint,
        associated_token::authority = whale,
    )]
    pub whale_wsol_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TriggerEngine<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"parent", parent_state.owner.as_ref()],
        bump = parent_state.bump
    )]
    pub parent_state: Account<'info, SlicerParent>,

    #[account(
        init,
        payer = cranker,
        space = 8 + 32 + 8 + 8 + 1,
        seeds = [b"slice", parent_state.key().as_ref(), parent_state.remaining_balance.to_le_bytes().as_ref()],
        bump
    )]
    pub child_slice: Account<'info, ChildSlice>, // FIX: Reverted back to ChildSlice

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillSlice<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"parent", parent.owner.as_ref()], 
        bump = parent.bump
    )]
    pub parent: Box<Account<'info, SlicerParent>>,

    #[account(mut)]
    pub child_slice: Box<Account<'info, ChildSlice>>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = parent,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_wsol_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub whale_usdc_account: Box<Account<'info, TokenAccount>>,

    pub wsol_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum SlicerError {
    #[msg("The vault is empty, cannot slice any more funds.")]
    VaultEmpty,

    #[msg("This slice has already been purchased.")]
    SliceAlreadyFilled,
}
