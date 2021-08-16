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

;(async () => {
  console.log('Fetching state..')
  const exchange = await Exchange.build(
    connection,
    Network.LOCAL,
    wallet,
    exchangeAuthority,
    exchangeProgram
  )
  console.log('Fetching accounts..')
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 510 }]
  })
  console.log('Calculating..')
  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  await Promise.all(
    accounts.map(async (user) => {
      console.log(await isLiquidateable(exchange, assetsList, user))
    })
  )
})()

const parseUser = (account: web3.AccountInfo<Buffer>) =>
  coder.decode<ExchangeAccount>('ExchangeAccount', account.data)

const isLiquidateable = async (
  exchange: Exchange,
  assetsList: AssetsList,
  user: { pubkey: PublicKey; account: AccountInfo<Buffer> }
) => {
  const exchangeAccount = parseUser(user.account)
  const userMaxDebt = await calculateUserMaxDebt(exchangeAccount, assetsList)
  const userDebt = await exchange.getUserDebtBalance(user.pubkey)
  return userDebt.gt(userMaxDebt)
}
