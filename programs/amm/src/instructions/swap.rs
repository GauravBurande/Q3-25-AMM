use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{ transfer_checked, Mint, Token, TokenAccount, TransferChecked},
};

use constant_product_curve::{ConstantProduct, LiquidityPair};
use crate::state::Config;
use crate::error::AmmError;

#[derive(Accounts)]
pub struct Swap<'info> {
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
        init_if_needed,
        payer = user,
        associated_token::mint = mint_x,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
     pub user_ata_x: Account<'info, TokenAccount>,
      #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_x,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
     pub user_ata_y: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    /// Associated Token program for ATA operations
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// System program for account creation
    pub system_program: Program<'info, System>,
}
 impl Swap<'_> {
     pub fn swap(&mut self, is_x: bool, amount_in: u64, min_amount_out:u64) -> Result<()> {
        require!(self.config.locked == false, AmmError::PoolLocked);
        require!(amount_in > 0, AmmError::InvalidAmount);

        let mut curve = ConstantProduct::init(self.vault_x.amount, self.vault_y.amount, self.mint_lp.supply, self.config.fee, None).map_err(AmmError::from)?;

        let p = match is_x {
            true => LiquidityPair::X,
            false => LiquidityPair::Y,
        };

        let swap_result = curve.swap(p, amount_in, min_amount_out).map_err(AmmError::from)?;

        require!(swap_result.deposit !=0, AmmError::InvalidAmount);
        require!(swap_result.withdraw !=0, AmmError::InvalidAmount);

        self.deposit_token(is_x, swap_result.deposit)?;
        self.withdraw_token(!is_x, swap_result.withdraw)?;

        Ok(())
     }

     pub fn deposit_token(&mut self, is_x: bool, amount_in: u64) -> Result<()> {

        let cpi_program = self.token_program.to_account_info();

        let (from, to, mint, decimals) = match is_x {
            true => (
                self.user_ata_x.to_account_info(),
                self.vault_x.to_account_info(),
                self.mint_x.to_account_info(),
                self.mint_x.decimals
            ),
            false => (
                self.user_ata_y.to_account_info(),
                self.vault_y.to_account_info(),
                self.mint_y.to_account_info(),
                self.mint_y.decimals
            )
        };

        let cpi_accounts = TransferChecked {
            from,
            to,
            mint,
            authority: self.user.to_account_info()
        };

        let cpi_context = CpiContext::new(cpi_program, cpi_accounts);

        transfer_checked(cpi_context, amount_in, decimals)?;

        Ok(())
     }

      pub fn withdraw_token(&mut self, is_x: bool, amount_out: u64) -> Result<()> {

        let cpi_program = self.token_program.to_account_info();

        let (from, to, mint, decimals) = match is_x {
            true => (
                self.vault_x.to_account_info(),
                self.user_ata_x.to_account_info(),
                self.mint_x.to_account_info(),
                self.mint_x.decimals
            ),
            false => (
                self.vault_y.to_account_info(),
                self.user_ata_y.to_account_info(),
                self.mint_y.to_account_info(),
                self.mint_y.decimals
            )
        };

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"config",
            &self.config.seed.to_le_bytes(),
            &[self.config.config_bump]
        ]];

        let cpi_accounts = TransferChecked {
            from,
            to,
            mint,
            authority: self.config.to_account_info()
        };

        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        transfer_checked(cpi_context, amount_out, decimals)?;

        Ok(())
     }
 }