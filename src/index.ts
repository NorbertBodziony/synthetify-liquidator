import * as web3 from '@solana/web3.js'
import { Connection, Account, PublicKey } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID, AccountInfo } from '@solana/spl-token'
import {
  calculateUserDebt,
  isLiquidatable,
  parseUser,
  createAccountsOnAllCollaterals,
  U64_MAX,
  UserWithDeadline
} from './utils'
const MINIMUM_XUSD = new BN(10).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 40 * 60 * 1000
const CHECK_AT_RISK_INTERVAL = 5 * 1000

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const connection = new Connection(web3.clusterApiUrl('devnet'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET

;(async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(
    connection,
    Network.LOCAL,
    provider.wallet,
    exchangeAuthority,
    exchangeProgram
  )

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  console.log('Assuring accounts on every collateral..')
  const collateralAccounts = await createAccountsOnAllCollaterals(wallet, connection, assetsList)

  const xUSDAddress = assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  const xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(MINIMUM_XUSD))
    console.warn(`Account is low on xUSD (${xUSDAccount.amount.toString()})`)

  // Main loop
  let nextFullCheck = 0
  let nextCheck = 0
  let atRisk: UserWithDeadline[] = []

  while (true) {
    if (Date.now() > nextFullCheck + CHECK_ALL_INTERVAL) {
      nextFullCheck = Date.now() + CHECK_ALL_INTERVAL
      // Fetching all accounts with debt over limit
      atRisk = await getAccountsAtRisk(exchange)
    }

    if (Date.now() > nextCheck + CHECK_AT_RISK_INTERVAL) {
      nextCheck = Date.now() + CHECK_AT_RISK_INTERVAL
      const slot = new BN(await connection.getSlot())

      console.log('Checking accounts suitable for liquidation..')
      console.time('checking time')
      while (atRisk.length) {
        // Users are sorted so we can stop checking if the deadline is in the future
        const user = atRisk[0]
        if (slot.lt(user.deadline)) break

        console.log('Liquidating..')

        await liquidate(exchange, user.address, state, collateralAccounts, wallet)
      }
      atRisk.shift()
      console.log('Finished checking')
      console.timeEnd('checking time')
    }

    const closerCheck = nextCheck > nextFullCheck ? nextCheck : nextFullCheck
    await sleep(closerCheck - Date.now() + 1)
  }
})()

const getAccountsAtRisk = async (exchange): Promise<UserWithDeadline[]> => {
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
    const liquidatable = isLiquidatable(state, assetsList, user)
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

const liquidate = async (
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

  const liquidatedEntry = exchangeAccount.collaterals[0]
  const liquidatedCollateral = assetsList.collaterals[liquidatedEntry.index]
  const { liquidationRate } = state

  const debt = calculateUserDebt(state, assetsList, exchangeAccount)
  const maxLiquidate = debt.mul(liquidationRate.val).divn(10 ** liquidationRate.scale)

  if (xUSDAccount.amount.lt(maxLiquidate)) console.error('Amount of xUSD too low')

  const amount = maxLiquidate.gt(xUSDAccount.amount) ? xUSDAccount.amount : maxLiquidate

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
