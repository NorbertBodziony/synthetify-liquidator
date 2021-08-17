import * as web3 from '@solana/web3.js'
import { Connection, Account, PublicKey, AccountInfo } from '@solana/web3.js'
import { AccountsCoder, Provider, BN } from '@project-serum/anchor'
import { Idl } from '@project-serum/anchor/dist/idl'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { ExchangeAccount, AssetsList, Exchange } from '@synthetify/sdk/lib/exchange'
import {
  calculateUserCollateral,
  calculateDebt,
  calculateUserMaxDebt
} from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'

const MINIMUM_XUSD = new BN(10).pow(new BN(8))

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const coder = new AccountsCoder(EXCHANGE_IDL as Idl)
const connection = new Connection(web3.clusterApiUrl('devnet'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET
const U64_MAX = new BN('18446744073709551615')

let atRisk = new Set<PublicKey>()

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
  const collateralAccounts = await createAccountsOnAllCollaterals(assetsList)

  const xUSDAddress = assetsList.synthetics[0].assetAddress
  const token = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  const xUSDAccount = await token.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(MINIMUM_XUSD))
    console.warn(`Account is low on xUSD (${xUSDAccount.amount.toString()})`)

  // Fetching all accounts with debt over limit
  atRisk = await getAccountsAtRisk(exchange)

  // Checking fetched accounts
  for (const exchangeAccount of atRisk) {
    const { liquidationDeadline } = await exchange.getExchangeAccount(exchangeAccount)
    if (liquidationDeadline.eq(U64_MAX)) await exchange.checkAccount(exchangeAccount)

    const slot = new BN(await connection.getSlot())

    if (slot.lt(liquidationDeadline)) return

    // await exchange.liquidate({
    //   exchangeAccount,
    //   signer: wallet.publicKey,
    //   liquidationFund: collateral.liquidationFund,
    //   amount: maxAmount,
    //   liquidatorCollateralAccount,
    //   liquidatorUsdAccount,
    //   reserveAccount: collateral.reserveAddress,
    //   signers: [wallet]
    // })
  }
})()

const parseUser = (account: web3.AccountInfo<Buffer>) =>
  coder.decode<ExchangeAccount>('ExchangeAccount', account.data)

const isLiquidatable = async (
  exchange: Exchange,
  assetsList: AssetsList,
  user: { pubkey: PublicKey; account: AccountInfo<Buffer> }
) => {
  const exchangeAccount = parseUser(user.account)
  const userMaxDebt = await calculateUserMaxDebt(exchangeAccount, assetsList)
  const userDebt = await exchange.getUserDebtBalance(user.pubkey)
  return userDebt.gt(userMaxDebt)
}

const getAccountsAtRisk = async (exchange): Promise<Set<PublicKey>> => {
  // Fetching all account associated with the exchange, and size of 510 (ExchangeAccount)
  console.log('Fetching accounts..')
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 510 }]
  })

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  console.log('Calculating..')
  let atRisk = new Set<PublicKey>()

  await Promise.all(
    accounts.map(async (user) => {
      const liquidatable = await isLiquidatable(exchange, assetsList, user)
      if (!liquidatable) return

      atRisk.add(user.pubkey)
      const deadline = parseUser(user.account).liquidationDeadline

      // Set a deadline if not already set
      if (deadline.eq(U64_MAX)) await exchange.checkAccount(user.pubkey)
    })
  )

  console.log('Done scanning accounts')
  return atRisk
}

const createAccountsOnAllCollaterals = async (assetsList: AssetsList) => {
  const accounts = await Promise.all(
    await assetsList.collaterals.slice(0, assetsList.headAssets).map(({ collateralAddress }) => {
      const token = new Token(connection, collateralAddress, TOKEN_PROGRAM_ID, wallet)
      return token.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    })
  )
  return accounts.map(({ address }) => address)
}
