pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("E6Q35ahMXEsREnpbMzSku4rqDNojGa6iD3XoAVcpSNAQ");

#[program]
pub mod arcslicer {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }
}
