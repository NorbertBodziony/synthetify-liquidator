import { Connection, Account, clusterApiUrl, PublicKey } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import { AssetsList, Exchange, ExchangeAccount, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { liquidate, getAccountsAtRisk, createAccountsOnAllCollaterals } from './utils'
import { cyan, yellow } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'

const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 10 * 1000
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

  // const state = await exchange.getState()
  const state = new Synchronizer<ExchangeState>(
    connection,
    exchange.stateAddress,
    'State',
    await exchange.getState()
  )

  const prices = new Prices(connection, await exchange.getAssetsList(state.account.assetsList))

  console.log('Assuring accounts on every collateral..')
  const collateralAccounts = await createAccountsOnAllCollaterals(
    wallet,
    connection,
    prices.assetsList
  )

  const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  let xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(XUSD_BEFORE_WARNING))
    console.warn(yellow(`Account is low on xUSD (${xUSDAccount.amount.toString()})`))

  // Main loop
  let nextFullCheck = 0
  let nextCheck = 0
  let atRisk: Synchronizer<ExchangeAccount>[] = []

  while (true) {
    if (Date.now() > nextFullCheck + CHECK_ALL_INTERVAL) {
      nextFullCheck = Date.now() + CHECK_ALL_INTERVAL
      // Fetching all accounts with debt over limit
      const newAccounts = await getAccountsAtRisk(
        connection,
        exchange,
        exchangeProgram,
        state,
        prices.assetsList
      )

      const freshAtRisk = newAccounts
        .filter((fresh) => !atRisk.some((old) => old.address.equals(fresh.address)))
        .sort((a, b) => a.data.liquidationDeadline.cmp(b.data.liquidationDeadline))
        .map((fresh) => {
          return new Synchronizer<ExchangeAccount>(
            connection,
            fresh.address,
            'ExchangeAccount',
            fresh.data
          )
        })

      atRisk = atRisk.concat(freshAtRisk)
    }

    if (Date.now() > nextCheck + CHECK_AT_RISK_INTERVAL) {
      nextCheck = Date.now() + CHECK_AT_RISK_INTERVAL
      const slot = new BN(await connection.getSlot())

      console.log(cyan(`Liquidating suitable accounts (${atRisk.length})..`))
      console.time('checking time')

      for (const exchangeAccount of atRisk) {
        // Users are sorted so we can stop checking if deadline is in the future
        if (slot.lt(exchangeAccount.account.liquidationDeadline)) break

        while (true) {
          const liquidated = await liquidate(
            exchange,
            exchangeAccount,
            prices.assetsList,
            state.account,
            collateralAccounts,
            wallet,
            xUSDAccount.amount,
            xUSDAccount.address
          )
          if (!liquidated) break
          xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
        }
      }

      xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
      console.log('Finished checking')
      console.timeEnd('checking time')
    }

    await sleep(Math.min(nextCheck, nextFullCheck) - Date.now() + 1)
  }
}

main()
