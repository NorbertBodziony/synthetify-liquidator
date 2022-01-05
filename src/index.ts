import { Connection, Account, clusterApiUrl, PublicKey, Keypair } from '@solana/web3.js'
import { Provider, BN, Wallet } from '@project-serum/anchor'
import { Network, DEV_NET, MAIN_NET } from '@synthetify/sdk/lib/network'
import { AssetsList, Exchange, ExchangeAccount, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { liquidate, getAccountsAtRisk, createAccountsOnAllCollaterals } from './utils'
import { cyan, yellow } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'
const secretWallet = new Wallet(
  Keypair.fromSecretKey(new Uint8Array(process.env.PRIV_KEY.split(',').map((a) => Number(a))))
)
console.log(`Your wallet address ${secretWallet.publicKey.toBase58()}`)
const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const NETWORK = Network.MAIN
const connection = new Connection('https://ssc-dao.genesysgo.net', 'recent')

const provider = new Provider(connection, secretWallet, { commitment: 'recent' })
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const { exchange: exchangeProgram, exchangeAuthority } = MAIN_NET

const main = async () => {
  try {
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
    await sleep(1000) // TODO fetch prices directly rather than wait fro update

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

    let atRisk: Synchronizer<ExchangeAccount>[] = []

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

    const slot = new BN(await connection.getSlot())

    console.log(cyan(`Liquidating suitable accounts (${atRisk.length})..`))
    console.time('checking time')

    for (const exchangeAccount of atRisk) {
      // Users are sorted so we can stop checking if deadline is in the future
      if (slot.lt(exchangeAccount.account.liquidationDeadline)) {
        console.log(
          `Slots left ${exchangeAccount.account.liquidationDeadline.sub(slot).toString()}`
        )
        continue
      }
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
      console.log(liquidated)
      xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    }

    xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    console.log('Finished checking')
    console.timeEnd('checking time')
    process.exit(0)
  } catch (error) {
    console.log('ERROR: ', error)
    process.exit(0)
  }
}

main()
