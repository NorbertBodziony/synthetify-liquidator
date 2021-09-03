import { Idl } from '@project-serum/anchor/dist/idl'
import { Connection, Account, PublicKey, AccountInfo } from '@solana/web3.js'
import { ExchangeAccount, AssetsList, ExchangeState, Exchange } from '@synthetify/sdk/lib/exchange'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { AccountsCoder, BN } from '@project-serum/anchor'
import { calculateDebt, calculateUserMaxDebt } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Synchronizer } from './synchronizer'
import { blue, green, red } from 'colors'

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)
export const U64_MAX = new BN('18446744073709551615')

export const isLiquidatable = (
  state: ExchangeState,
  assetsList: AssetsList,
  exchangeAccount: ExchangeAccount
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
    await assetsList.collaterals.map(({ collateralAddress }) => {
      const token = new Token(connection, collateralAddress, TOKEN_PROGRAM_ID, wallet)
      return token.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    })
  )
  return accounts.map(({ address }) => address)
}

export const liquidate = async (
  exchange: Exchange,
  exchangeAccount: Synchronizer<ExchangeAccount>,
  assetsList: Synchronizer<AssetsList>,
  state: Synchronizer<ExchangeState>,
  collateralAccounts: PublicKey[],
  wallet: Account,
  xUSDBalance: BN,
  xUSDAccountAddress: PublicKey
) => {
  if (!isLiquidatable(state.account, assetsList.account, exchangeAccount.account)) return false

  console.log(green('Liquidating..'))

  const liquidatedEntry = exchangeAccount.account.collaterals[0]
  const liquidatedCollateral = assetsList.account.collaterals[liquidatedEntry.index]
  const { liquidationRate } = state.account

  const debt = calculateUserDebt(state.account, assetsList.account, exchangeAccount.account)
  const maxLiquidate = debt.mul(liquidationRate.val).divn(10 ** liquidationRate.scale)
  // Taking .1% for debt change
  const amountNeeded = new BN(maxLiquidate).muln(999).divn(1000)

  if (xUSDBalance.lt(amountNeeded)) {
    if (xUSDBalance.eqn(0)) {
      console.error(red('xUSD Account is empty'))
      // throw Error('No xUSD in account')
      return false
    }
    console.error(`Amount of xUSD too low, using ${xUSDBalance.toString()}`)
  }

  const amount = amountNeeded.gt(xUSDBalance) ? xUSDBalance : U64_MAX

  const liquidatorCollateralAccount = collateralAccounts[liquidatedEntry.index]

  await exchange.liquidate({
    exchangeAccount: exchangeAccount.address,
    signer: wallet.publicKey,
    liquidationFund: liquidatedCollateral.liquidationFund,
    amount,
    liquidatorCollateralAccount,
    liquidatorUsdAccount: xUSDAccountAddress,
    reserveAccount: liquidatedCollateral.reserveAddress,
    signers: [wallet]
  })

  return true
}

export const getAccountsAtRisk = async (
  connection: Connection,
  exchange: Exchange,
  exchangeProgram: PublicKey,
  state: Synchronizer<ExchangeState>,
  assetsList: Synchronizer<AssetsList>
): Promise<UserWithAddress[]> => {
  // Fetching all account associated with the exchange, and size of 1420 (ExchangeAccount)
  console.log('Fetching accounts..')
  console.time('fetching time')

  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1420 }]
  })

  console.timeEnd('fetching time')
  console.log(`Calculating debt for (${accounts.length}) accounts..`)
  console.time('calculating time')
  let atRisk: UserWithAddress[] = []
  let markedCounter = 0

  for (const user of accounts) {
    const liquidatable = isLiquidatable(state.account, assetsList.account, parseUser(user.account))
    if (!liquidatable) continue

    const exchangeAccount = parseUser(user.account)

    // Set a deadline if not already set
    if (exchangeAccount.liquidationDeadline.eq(U64_MAX)) {
      await exchange.checkAccount(user.pubkey)
      const exchangeAccount = await exchange.getExchangeAccount(user.pubkey)

      atRisk.push({ address: user.pubkey, data: exchangeAccount })

      markedCounter++
    } else atRisk.push({ address: user.pubkey, data: exchangeAccount })
  }

  console.log('Done scanning accounts')
  console.timeEnd('calculating time')

  console.log(blue(`Found: ${atRisk.length} accounts at risk, and marked ${markedCounter} new`))
  return atRisk
}

export interface UserWithAddress {
  address: PublicKey
  data: ExchangeAccount
}
