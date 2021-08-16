import * as web3 from '@solana/web3.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { AccountsCoder } from '@project-serum/anchor'
import { Idl } from '@project-serum/anchor/dist/idl'
import { ExchangeAccount, AssetsList, ExchangeState } from '@synthetify/sdk/lib/exchange'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'

const PROGRAM_ID = new PublicKey('2MDpnAdPjS6EJgRiVEGMFK9mgNgxYv2tvUpPCxJrmrJX')

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)

;(async () => {
  console.log('Starting liquidation..')
  var connection = new Connection(web3.clusterApiUrl('devnet'), 'confirmed')

  var wallet = Keypair.generate()
  await connection.requestAirdrop(wallet.publicKey, web3.LAMPORTS_PER_SOL)

  const accounts: ExchangeAccount[] = await (
    await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 509 }] })
  ).map(({ account }) => coder.decode<ExchangeAccount>('ExchangeAccount', account.data))

  console.log(accounts)
})()
