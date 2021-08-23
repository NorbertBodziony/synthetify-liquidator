import { Idl } from '@project-serum/anchor/dist/idl'
import { Connection, Account, PublicKey, AccountInfo } from '@solana/web3.js'
import { ExchangeAccount, AssetsList, ExchangeState, Exchange } from '@synthetify/sdk/lib/exchange'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { AccountsCoder, BN } from '@project-serum/anchor'
import { calculateDebt, calculateUserMaxDebt } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)
export const U64_MAX = new BN('18446744073709551615')

export const isLiquidatable = (
  state: ExchangeState,
  assetsList: AssetsList,
  exchangeAccount: ExchangeAccount
  // user: { pubkey: PublicKey; account: AccountInfo<Buffer> }
) => {
  if (exchangeAccount.debtShares.eq(new BN(0))) return false

  const userMaxDebt = calculateUserMaxDebt(exchangeAccount, assetsList)
  const userDebt = calculateUserDebt(state, assetsList, exchangeAccount)
  return userDebt.gt(userMaxDebt)
}

export const calculateUserDebt = (
  state: ExchangeState,
  assetsList: AssetsList,
  exchangeAccount: ExchangeAccount
) => {
  const debt = calculateDebt(assetsList)
  return exchangeAccount.debtShares.mul(debt).div(state.debtShares)
}

export const parseUser = (account: AccountInfo<Buffer>) =>
  coder.decode<ExchangeAccount>('ExchangeAccount', account.data)

export const createAccountsOnAllCollaterals = async (
  wallet: Account,
  connection: Connection,
  assetsList: AssetsList
) => {
  const accounts = await Promise.all(
    await assetsList.collaterals.slice(0, assetsList.headAssets).map(({ collateralAddress }) => {
      const token = new Token(connection, collateralAddress, TOKEN_PROGRAM_ID, wallet)
      return token.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    })
  )
  return accounts.map(({ address }) => address)
}

export const liquidate = async (
  connection: Connection,
  exchange: Exchange,
  account: PublicKey,
  state: ExchangeState,
  collateralAccounts: PublicKey[],
  wallet: Account
) => {
  const exchangeAccount = await exchange.getExchangeAccount(account)
  const assetsList = await exchange.getAssetsList(state.assetsList)
  const xUSDToken = new Token(
    connection,
    assetsList.synthetics[0].assetAddress,
    TOKEN_PROGRAM_ID,
    wallet
  )
  const xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (!isLiquidatable(state, assetsList, exchangeAccount)) return

  console.log('Liquidating..')

  const liquidatedEntry = exchangeAccount.collaterals[0]
  const liquidatedCollateral = assetsList.collaterals[liquidatedEntry.index]
  const { liquidationRate } = state

  const debt = calculateUserDebt(state, assetsList, exchangeAccount)
  const maxLiquidate = debt.mul(liquidationRate.val).divn(10 ** liquidationRate.scale)
  // Taking .1% for debt change
  const amountNeeded = new BN(maxLiquidate).muln(999).divn(1000)

  if (xUSDAccount.amount.lt(amountNeeded)) console.error('Amount of xUSD too low')

  const amount = amountNeeded.gt(xUSDAccount.amount) ? xUSDAccount.amount : U64_MAX

  await exchange.liquidate({
    exchangeAccount: account,
    signer: wallet.publicKey,
    liquidationFund: liquidatedCollateral.liquidationFund,
    amount,
    liquidatorCollateralAccount: collateralAccounts[liquidatedEntry.index],
    liquidatorUsdAccount: xUSDAccount.address,
    reserveAccount: liquidatedCollateral.reserveAddress,
    signers: [wallet]
  })
}

export const getAccountsAtRisk = async (
  connection: Connection,
  exchange: Exchange,
  exchangeProgram: PublicKey
): Promise<UserWithDeadline[]> => {
  // Fetching all account associated with the exchange, and size of 510 (ExchangeAccount)
  console.log('Fetching accounts..')
  console.time('fetching time')

  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1421 }]
  })

  const state: ExchangeState = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  console.timeEnd('fetching time')
  console.log(`Calculating debt for (${accounts.length}) accounts..`)
  console.time('calculating time')
  let atRisk: UserWithDeadline[] = []
  let markedCounter = 0

  accounts.forEach(async (user) => {
    const liquidatable = isLiquidatable(state, assetsList, parseUser(user.account))
    if (!liquidatable) return

    const deadline = parseUser(user.account).liquidationDeadline

    // Set a deadline if not already set
    if (deadline.eq(U64_MAX)) {
      await exchange.checkAccount(user.pubkey)
      const { liquidationDeadline } = await exchange.getExchangeAccount(user.pubkey)

      atRisk.push({ address: user.pubkey, deadline: liquidationDeadline })

      markedCounter++
    } else atRisk.push({ address: user.pubkey, deadline })
  })

  atRisk = atRisk.sort((a, b) => a.deadline.cmp(b.deadline))

  console.log('Done scanning accounts')
  console.timeEnd('calculating time')

  console.log(`Found: ${atRisk.length} accounts at risk, and marked ${markedCounter} new`)
  return atRisk
}

export interface UserWithDeadline {
  address: PublicKey
  deadline: BN
}
