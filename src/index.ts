import * as web3 from '@solana/web3.js'
import { Connection, Keypair, PublicKey, AccountInfo } from '@solana/web3.js'
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

// const PROGRAM_ID = new PublicKey('2MDpnAdPjS6EJgRiVEGMFK9mgNgxYv2tvUpPCxJrmrJX')

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)
const connection = new Connection(web3.clusterApiUrl('devnet'), 'confirmed')
const { wallet } = Provider.local()
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET
const U64_MAX = new BN('18446744073709551615')

let atRisk = new Set<PublicKey>()

;(async () => {
  //
  console.log('Initialization')
  const exchange = await Exchange.build(
    connection,
    Network.LOCAL,
    wallet,
    exchangeAuthority,
    exchangeProgram
  )

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)
  console.log('Done')

  // Fetching all accounts with debt over limit
  atRisk = await getAccountsAtRisk(exchange)

  // Checking fetched accounts
  for (const account of atRisk) {
    const { liquidationDeadline } = await exchange.getExchangeAccount(account)
    if (liquidationDeadline.eq(U64_MAX)) await exchange.checkAccount(account)
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

      // Set a deadline if not alreadys set
      if (deadline.eq(U64_MAX)) await exchange.checkAccount(user.pubkey)
    })
  )

  console.log('Done scanning accounts')
  return atRisk
}
