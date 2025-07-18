import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  MINT_SIZE,
  createInitializeMint2Instruction,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";

import { expect } from "chai";

describe("amm", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.amm as Program<Amm>;

  const confirm = async (signature: string) => {
    const block = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      ...block,
    });

    return signature;
  };

  const log = (signature: string) => {
    console.log(
      `Your transaction signature: https://explorer.solana.com/transaction/${signature}?cluster=custom&customUrl=${connection.rpcEndpoint}`
    );
    return signature;
  };

  const provider = anchor.getProvider();
  const connection = provider.connection;

  const admin = provider.wallet.payer;
  const programId = program.programId;
  const tokenProgram = anchor.utils.token.TOKEN_PROGRAM_ID;
  const associatedTokenProgram = anchor.utils.token.ASSOCIATED_PROGRAM_ID;
  const systemProgram = anchor.web3.SystemProgram.programId;

  const SEED = new anchor.BN(696);
  const FEE = 300;
  let configPda: anchor.web3.PublicKey;
  let mintLp: anchor.web3.PublicKey;

  let mintX: anchor.web3.PublicKey, mintY: anchor.web3.PublicKey;
  let vaultX: anchor.web3.PublicKey, vaultY: anchor.web3.PublicKey;
  let userAtaX: anchor.web3.PublicKey, userAtaY: anchor.web3.PublicKey;
  // userAtaLp: anchor.web3.PublicKey;

  before(async () => {
    try {
      [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config"), SEED.toArrayLike(Buffer, "le", 8)],
        programId
      );
    } catch (err) {
      console.error("Error finding config PDA:", err);
      throw err;
    }

    try {
      // todo: ask Johnny about if this can be created in program if used accounts without partial thing
      [mintLp] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("lp"), configPda.toBuffer()],
        programId
      );

      // const lamportsForMint =
      //   await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

      // const tx = new anchor.web3.Transaction();

      // tx.add(
      //   SystemProgram.createAccount({
      //     fromPubkey: admin.publicKey,
      //     newAccountPubkey: mintLp,
      //     space: MINT_SIZE,
      //     lamports: lamportsForMint,
      //     programId: tokenProgram,
      //   })
      // );

      // tx.add(createInitializeMint2Instruction(mintLp, 6, configPda, null));

      // await provider.sendAndConfirm(tx, []);
    } catch (err) {
      console.error("Error finding mintLp PDA:", err);
      throw err;
    }

    try {
      [mintX, mintY] = await Promise.all(
        Array.from({ length: 2 }, () =>
          createMint(connection, admin, admin.publicKey, null, 6)
        )
      );
    } catch (err) {
      console.error("Error creating mints X and Y:", err);
      throw err;
    }

    try {
      [vaultX, vaultY] = await Promise.all(
        [mintX, mintY].map((m) => {
          return getAssociatedTokenAddress(m, configPda, true);
        })
      );
    } catch (err) {
      console.error(
        "Error getting associated token addresses for vaults X and Y:",
        err
      );
      throw err;
    }

    try {
      [userAtaX, userAtaY] = await Promise.all(
        [mintX, mintY].map(async (m) => {
          try {
            const ata = await getOrCreateAssociatedTokenAccount(
              connection,
              admin,
              m,
              admin.publicKey
            );
            return ata.address;
          } catch (err) {
            console.error(
              `Error getting/creating user ATA for mint ${m.toBase58()}:`,
              err
            );
            throw err;
          }
        })
      );
    } catch (err) {
      console.error("Error getting/creating user ATAs for X and Y:", err);
      throw err;
    }

    /// todo: ask for this one with the above mintLp
    // try {
    //   userAtaLp = await getOrCreateAssociatedTokenAccount(
    //     connection,
    //     admin,
    //     mintLp,
    //     admin.publicKey
    //   ).then((account) => account.address);
    // } catch (err) {
    //   console.error("Error getting/creating user ATA for LP mint:", err);
    //   throw err;
    // }
  });

  it("Is initialized!", async () => {
    await program.methods
      .initialize(SEED, FEE, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        mintLp,
        mintX,
        mintY,
        vaultX,
        vaultY,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      })
      .rpc()
      .then(confirm)
      .then(log);
  });

  it("deposit", async () => {
    const amount = new anchor.BN(1_000);
    const maxX = new anchor.BN(500_000);
    const maxY = new anchor.BN(500_000);

    await Promise.all(
      [
        { userAta: userAtaX, mint: mintX },
        { userAta: userAtaY, mint: mintY },
      ].map((u) => {
        return mintTo(connection, admin, u.mint, u.userAta, admin, 1_000_000);
      })
    );
    await program.methods
      .deposit(amount, maxX, maxY)
      .accountsPartial({
        user: admin.publicKey,
        config: configPda,
        mintLp,
        mintX,
        mintY,
        vaultX,
        vaultY,
        // userAtaLp,
        userAtaX,
        userAtaY,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      })
      .rpc()
      .then(confirm)
      .then(log);

    const vaultAtaXAccount = await getAccount(connection, vaultX);
    const vaultAtaYAccount = await getAccount(connection, vaultX);
    // const userAtaLpAccount = await getAccount(connection, userAtaLp);

    expect(
      vaultAtaXAccount.amount == BigInt(String(maxX)) &&
        // userAtaLpAccount.amount == BigInt(String(amount)) &&
        vaultAtaYAccount.amount == BigInt(String(maxY)),
      "something went wrong with the vault and lp amount"
    );
  });

  it("swapX", async () => {
    const amountIn = new anchor.BN(400_000);
    const minAmountOut = new anchor.BN(200_000);
    await program.methods
      .swap(true, amountIn, minAmountOut)
      .accountsPartial({
        user: admin.publicKey,
        config: configPda,
        mintLp,
        mintX,
        mintY,
        userAtaX,
        userAtaY,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      })
      .rpc()
      .then(confirm)
      .then(log);

    const userAtaXAccount = await getAccount(connection, userAtaX);
    const userAtaYAccount = await getAccount(connection, userAtaY);

    expect(userAtaXAccount.amount == BigInt(100_000), "swap x went wrong!");
    console.info(
      "user bought y token, 500_000 + new amount: ",
      userAtaYAccount.amount
    );
    console.info(
      "user sold x token, 500_000 - 400_000 new amount: ",
      userAtaXAccount.amount
    );
  });

  it("swapY", async () => {
    const amountIn = new anchor.BN(400_000);
    const minAmountOut = new anchor.BN(400_000);

    await program.methods
      .swap(false, amountIn, minAmountOut)
      .accountsPartial({
        user: admin.publicKey,
        config: configPda,
        mintLp,
        mintX,
        mintY,
        userAtaX,
        userAtaY,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      })
      .rpc()
      .then(confirm)
      .then(log);

    const userAtaXAccount = await getAccount(connection, userAtaX);
    const userAtaYAccount = await getAccount(connection, userAtaY);

    console.info("user bought x token, new amount: ", userAtaXAccount.amount);
    console.info("user sold y token, new amount: ", userAtaYAccount.amount);
    const vaultAtaXAccount = await getAccount(connection, vaultX);
    const vaultAtaYAccount = await getAccount(connection, vaultY);
    console.info(
      "vault x token account, new amount: ",
      vaultAtaXAccount.amount
    );
    console.info(
      "vault y token account, new amount: ",
      vaultAtaYAccount.amount
    );
  });

  it("withdraw liquidity", async () => {
    const amount = new anchor.BN(1_000);
    const minX = new anchor.BN(100_000);
    const minY = new anchor.BN(100_000);

    await program.methods
      .withdraw(amount, minX, minY)
      .accountsPartial({
        user: admin.publicKey,
        config: configPda,
        mintLp,
        // userAtaLp,
        vaultX,
        vaultY,
        userAtaX,
        userAtaY,
        mintX,
        mintY,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      })
      .rpc()
      .then(confirm)
      .then(log);

    const userAtaXAccount = await getAccount(connection, userAtaX);
    const userAtaYAccount = await getAccount(connection, userAtaY);
    const vaultAtaXAccount = await getAccount(connection, vaultX);
    const vaultAtaYAccount = await getAccount(connection, vaultY);
    // const userAtaLpAccount = await getAccount(connection, userAtaLp);

    console.info("user x token account, new amount: ", userAtaXAccount.amount);
    console.info("user y token account, new amount: ", userAtaYAccount.amount);
    console.info(
      "vault x token account, new amount: ",
      vaultAtaXAccount.amount
    );
    console.info(
      "vault y token account, new amount: ",
      vaultAtaYAccount.amount
    );
  });
});
