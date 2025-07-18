use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{burn, transfer_checked, Mint, Burn, Token, TokenAccount, TransferChecked},
};

use constant_product_curve::ConstantProduct;
use crate::state::Config;
use crate::error::AmmError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub mint_x: Account<'info, Mint>,
    pub mint_y: Account<'info, Mint>,

    #[account(
        seeds = [b"config", config.seed.to_le_bytes().as_ref()],
        bump = config.config_bump,
        has_one = mint_x,
        has_one = mint_y
    )]
    pub config: Account<'info, Config>,

    #[account(
        seeds=[b"lp", config.key().as_ref()],
        bump = config.lp_bump
    )]
    pub mint_lp: Account<'info, Mint>,

    #[account(
        associated_token::mint = mint_x,
        associated_token::authority = config,
        associated_token:: token_program = token_program
    )]
    pub vault_x: Account<'info, TokenAccount>,
    #[account(
        associated_token::mint = mint_y,
        associated_token::authority = config,
        associated_token:: token_program = token_program
    )]
    pub vault_y: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
     pub user_ata_x: Account<'info, TokenAccount>,
      #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
     pub user_ata_y: Account<'info, TokenAccount>,

      #[account(
        associated_token::mint = mint_lp,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
     pub user_ata_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    /// Associated Token program for ATA operations
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// System program for account creation
    pub system_program: Program<'info, System>,
}

impl Withdraw<'_> {
    pub fn withdraw(&mut self, amount:u64, min_x: u64, min_y:u64) -> Result<()> {
        require!(self.config.locked == false, AmmError::PoolLocked);
        require!(self.user_ata_lp.amount != 0, AmmError::NoLiquidityInPool); //todo: ask if I did correct here, like check for 0 lp tokens and if the error enum is correct
        require!(amount !=0, AmmError::InvalidAmount);

        let (x, y) = match self.mint_lp.supply == 0 && self.vault_x.amount == 0
            && self.vault_y.amount == 0 {
             // Edge case: if pool is completely empty, use minimum amounts
            // This shouldn't happen in normal operation but provides safety
            true => (min_x, min_y),
            false => {
                let amounts = ConstantProduct::xy_withdraw_amounts_from_l(self.vault_x.amount, self.vault_y.amount, self.mint_lp.supply, amount, 6).unwrap();
                (amounts.x, amounts.y)
            }
        };

        // Slippage protection: ensure calculated amounts meet user's minimum requirements
        require!(x>= min_x && y>= min_y, AmmError::SlippageExceeded);

        self.withdraw_tokens(true, x)?;
        self.withdraw_tokens(false, y)?;

        self.burn_lp_tokens(amount)?;
        Ok(())
    }

    pub fn withdraw_tokens(&mut self, is_x: bool, amount:u64) -> Result<()> {

        let (from, to, mint, decimals) = match is_x {
            true => (
                self.vault_x.to_account_info(),   
                self.user_ata_x.to_account_info(),
                self.mint_x.to_account_info(),    
                self.mint_x.decimals, 
            ),
            false => (
                self.vault_y.to_account_info(),   
                self.user_ata_y.to_account_info(),
                self.mint_y.to_account_info(),    
                self.mint_y.decimals, 
            )
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = TransferChecked {
            from,
            to,
            authority: self.config.to_account_info(), // Config PDA has authority over vaults and other etc...
            mint,
        };

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"config",
            &self.config.seed.to_le_bytes(),
            &[self.config.config_bump],
        ]];

        // Create CPI context with PDA signer
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        transfer_checked(cpi_context, amount, decimals)?;
        Ok(())
    }

    fn burn_lp_tokens(&mut self, amount:u64) -> Result<()> {
        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Burn {
            from: self.user_ata_lp.to_account_info(),
            mint: self.mint_lp.to_account_info(),
            authority: self.user.to_account_info()
        };

        let cpi_context = CpiContext::new(cpi_program, cpi_accounts);

        burn(cpi_context, amount)?;
        Ok(())
    }
}