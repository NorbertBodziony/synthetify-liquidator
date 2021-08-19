import * as web3 from '@solana/web3.js'
import { Connection, Account } from '@solana/web3.js'
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
const MINIMUM_XUSD = new BN(10).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 40 * 60 * 1000
const CHECK_AT_RISK_INTERVAL = 5 * 1000

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const connection = new Connection(web3.clusterApiUrl('devnet'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET

const main = async () => {
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
      atRisk = await getAccountsAtRisk(connection, exchange, exchangeProgram)
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

        await liquidate(connection, exchange, user.address, state, collateralAccounts, wallet)
      }
      atRisk.shift()
      console.log('Finished checking')
      console.timeEnd('checking time')
    }

    const closerCheck = nextCheck < nextFullCheck ? nextCheck : nextFullCheck
    await sleep(closerCheck - Date.now() + 1)
  }
}

main()
