import { Idl } from '@project-serum/anchor/dist/idl'
import { Connection, Account, PublicKey, AccountInfo, clusterApiUrl } from '@solana/web3.js'
import { ExchangeAccount, AssetsList, Exchange, ExchangeState } from '@synthetify/sdk/lib/exchange'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { AccountsCoder, Provider, BN } from '@project-serum/anchor'
import {
  calculateUserCollateral,
  calculateDebt,
  calculateUserMaxDebt,
  ACCURACY
} from '@synthetify/sdk/lib/utils'
import { connect } from 'http2'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)

export const isLiquidatable = (
  state: ExchangeState,
  assetsList: AssetsList,
  user: { pubkey: PublicKey; account: AccountInfo<Buffer> }
) => {
  const exchangeAccount = parseUser(user.account)
  if (exchangeAccount.debtShares.eq(new BN(0))) return false

  const userMaxDebt = calculateUserMaxDebt(exchangeAccount, assetsList)
  const debt = calculateDebt(assetsList)
  const userDebt = exchangeAccount.debtShares.mul(debt).div(state.debtShares)
  return userDebt.gt(userMaxDebt)
}

export const parseUser = (account: AccountInfo<Buffer>) =>
  coder.decode<ExchangeAccount>('ExchangeAccount', account.data)

export const createAccountsOnAllCollaterals = async (
  wallet: Account,
  connection: Connection,
  assetsList: AssetsList
) => {
  const accounts = await Promise.all(
    await assetsList.collaterals.slice(0, assetsList.headAssets).map(({ collateralAddress }) => {
      const token = new Token(connection, collateralAddress, TOKEN_PROGRAM_ID, wallet)
      return token.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    })
  )
  return accounts.map(({ address }) => address)
}
