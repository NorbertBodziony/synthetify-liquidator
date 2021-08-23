import { Connection, Account, clusterApiUrl } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import { Exchange } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  liquidate,
  getAccountsAtRisk,
  createAccountsOnAllCollaterals,
  UserWithDeadline
} from './utils'
import { Prices } from './prices'

const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 40 * 60 * 1000
const CHECK_AT_RISK_INTERVAL = 5 * 1000
const NETWORK = Network.DEV

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET

const main = async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(
    connection,
    NETWORK,
    provider.wallet,
    exchangeAuthority,
    exchangeProgram
  )

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  await new Prices(connection, assetsList)

  console.log('Assuring accounts on every collateral..')
  const collateralAccounts = await createAccountsOnAllCollaterals(wallet, connection, assetsList)

  const xUSDAddress = assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  const xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(XUSD_BEFORE_WARNING))
    console.warn(`Account is low on xUSD (${xUSDAccount.amount.toString()})`)

  // Main loop
  let nextFullCheck = 0
  let nextCheck = 0
  let atRisk: UserWithDeadline[] = []

  while (true) {
    if (Date.now() > nextFullCheck + CHECK_ALL_INTERVAL) {
      nextFullCheck = Date.now() + CHECK_ALL_INTERVAL
      // Fetching all accounts with debt over limit
      atRisk = atRisk.concat(await getAccountsAtRisk(connection, exchange, exchangeProgram))
    }

    if (Date.now() > nextCheck + CHECK_AT_RISK_INTERVAL) {
      nextCheck = Date.now() + CHECK_AT_RISK_INTERVAL
      const slot = new BN(await connection.getSlot())

      console.log(`Checking accounts suitable for liquidation (${atRisk.length})..`)
      console.time('checking time')

      for (const account of atRisk) {
        // Users are sorted so we can stop checking if deadline is in the future
        if (slot.lt(account.deadline)) break

        await liquidate(connection, exchange, account.address, state, collateralAccounts, wallet)
      }

      console.log('Finished checking')
      console.timeEnd('checking time')
    }

    const closerCheck = nextCheck < nextFullCheck ? nextCheck : nextFullCheck
    await sleep(closerCheck - Date.now() + 1)
  }
}

main()
