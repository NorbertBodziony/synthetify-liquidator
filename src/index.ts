import * as web3 from '@solana/web3.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { AccountsCoder, Provider, BN } from '@project-serum/anchor'
import { Idl } from '@project-serum/anchor/dist/idl'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { ExchangeAccount, AssetsList, Exchange } from '@synthetify/sdk/lib/exchange'

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
  const assetsList = await exchange.getAssetsList((await exchange.getState()).assetsList)
  console.log(assetsList)

  console.log('Fetching accounts..')

  const accounts: ExchangeAccount[] = await (
    await connection.getProgramAccounts(exchangeProgram, { filters: [{ dataSize: 509 }] })
  ).map(({ account }) => coder.decode<ExchangeAccount>('ExchangeAccount', account.data))

  console.log(accounts)
})()
