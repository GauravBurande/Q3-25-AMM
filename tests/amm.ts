import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
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
  let userAtaX: anchor.web3.PublicKey,
    userAtaY: anchor.web3.PublicKey,
    userAtaLp: anchor.web3.PublicKey;

  before(async () => {
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config"), SEED.toArrayLike(Buffer, "le", 8)],
      programId
    );
    [mintLp] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), configPda.toBuffer()],
      programId
    );

    [mintX, mintY] = await Promise.all(
      Array.from({ length: 2 }, () =>
        createMint(connection, admin, admin.publicKey, null, 6)
      )
    );

    [vaultX, vaultY] = await Promise.all(
      [mintX, mintY].map((m) => {
        return getAssociatedTokenAddress(m, configPda, true);
      })
    );

    [userAtaX, userAtaY] = await Promise.all(
      [mintX, mintY].map(async (m) => {
        const ata = await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          m,
          admin.publicKey
        );

        return ata.address;
      })
    );

    userAtaLp = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mintLp,
      admin.publicKey
    ).then((account) => account.address);
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
        userAtaLp,
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
    const userAtaLpAccount = await getAccount(connection, userAtaLp);

    expect(
      vaultAtaXAccount.amount == BigInt(String(maxX)) &&
        vaultAtaYAccount.amount == BigInt(String(maxY)) &&
        userAtaLpAccount.amount == BigInt(String(amount)),
      "something went wrong with the vault and lp amount"
    );
  });

  it("swapX", async () => {
    const amountIn = new anchor.BN(400_000);
    const minAmountOut = new anchor.BN(400_000);
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
  });

  it("swapY", async () => {
    const amountIn = new anchor.BN(400_000);
    const minAmountOut = new anchor.BN(400_000);

    const userAtaAmountShouldBeAccordingToTheObviousLogicThatYouCanReadTheCodeAboveAndFigureOutToo =
      BigInt(500_000);
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

    expect(
      userAtaXAccount.amount ==
        userAtaAmountShouldBeAccordingToTheObviousLogicThatYouCanReadTheCodeAboveAndFigureOutToo &&
        userAtaYAccount.amount ==
          userAtaAmountShouldBeAccordingToTheObviousLogicThatYouCanReadTheCodeAboveAndFigureOutToo,
      "something went wrong with the swap, user ata amounts not right!"
    );
  });

  it("withdraw liquidity", async () => {
    const amount = new anchor.BN(1_000);
    const minX = new anchor.BN(500_000);
    const minY = new anchor.BN(500_000);

    const theOgAmount = BigInt(1_000_000);
    await program.methods
      .withdraw(amount, minX, minY)
      .accountsPartial({
        user: admin.publicKey,
        config: configPda,
        mintLp,
        userAtaLp,
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
    const userAtaLpAccount = await getAccount(connection, userAtaLp);

    expect(
      userAtaXAccount.amount == theOgAmount &&
        userAtaYAccount.amount == theOgAmount &&
        userAtaLpAccount.amount == BigInt(0),
      "something went wrong with the vault and lp amount"
    );
  });
});
