use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, transfer_checked, Mint, MintTo, Token, TokenAccount, TransferChecked},
};

use constant_product_curve::ConstantProduct;
use crate::state::Config;
use crate::error::AmmError;

#[derive(Accounts)]
pub struct Deposit<'info> {
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
        mut,
        seeds=[b"lp", config.key().as_ref()],
        bump = config.lp_bump
    )]
    pub mint_lp: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = config,
        associated_token:: token_program = token_program
    )]
    pub vault_x: Account<'info, TokenAccount>,
    #[account(
        mut,
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
        associated_token::mint = mint_y,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
     pub user_ata_y: Account<'info, TokenAccount>,

      #[account(
        init_if_needed,
        payer = user,
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

impl Deposit<'_> {
    pub fn deposit(&mut self, amount: u64, max_x: u64, max_y: u64) -> Result<()> {
        require!(self.config.locked == false, AmmError::PoolLocked);

        require!(amount != 0, AmmError::InvalidAmount);

        let (x, y) = match self.mint_lp.supply == 0 && self.vault_x.amount == 0 && self.vault_y.amount == 0 {
            true => (max_x, max_y),
            false => {
                let amounts = ConstantProduct::xy_deposit_amounts_from_l(self.vault_x.amount, self.vault_y.amount, self.mint_lp.supply, amount, 6).unwrap();
                (amounts.x, amounts.y)
            }
        };

        require!(x<= max_x && y <=max_y, AmmError::SlippageExceeded);

        self.deposit_tokens(true, x)?;
        self.deposit_tokens(false, y)?;
        
        self.mint_lp_tokens(amount)?;
        Ok(())
    }

    pub fn deposit_tokens(&mut self, is_x: bool, amount:u64) -> Result<()> {
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

        transfer_checked(cpi_context, amount, decimals)?;

        Ok(())
    }

    pub fn mint_lp_tokens(&mut self, amount: u64) -> Result<()> {
        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = MintTo {
            to: self.user_ata_lp.to_account_info(),
            mint: self.mint_lp.to_account_info(),
            authority: self.config.to_account_info(),
        };

        let seeds = &[
            b"config",
            &self.config.seed.to_le_bytes()[..], //todo: this works but try not spreading it and maybe using as_ref() method
            &[self.config.config_bump]
        ];
        
        let signer_seeds = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        mint_to(cpi_context, amount)?;
        Ok(())
    }
}