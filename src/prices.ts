import { Connection, PublicKey } from '@solana/web3.js'
import { parsePriceData } from '@pythnetwork/client'
import { AssetsList } from '@synthetify/sdk/lib/exchange'
import { AccountsCoder, BN } from '@project-serum/anchor'
import { ORACLE_OFFSET } from '@synthetify/sdk'
import { toDecimal } from '@synthetify/sdk/lib/utils'

export class Prices {
  public assetsList: AssetsList
  private connection: Connection

  private constructor(connection: Connection, assetsList: AssetsList) {
    this.connection = connection
    this.assetsList = assetsList

    // Subscribe to oracle updates
    this.assetsList.assets.forEach(({ feedAddress }, index) => {
      connection.onAccountChange(feedAddress, (accountInfo) => {
        const { price } = parsePriceData(accountInfo.data)
        if (price == null) return

        this.assetsList.assets[index].price = toDecimal(
          new BN(price * 10 ** ORACLE_OFFSET),
          ORACLE_OFFSET
        )
      })
    })
  }

  public static async build<T>(connection: Connection, assetsList: AssetsList) {
    await Promise.all(
      assetsList.assets.map(async ({ feedAddress }, index) => {
        // don't update the price of USD
        if (index == 0) return
        const account = await connection.getAccountInfo(feedAddress)

        if (account == null) throw new Error('invalid account')
        const { price } = parsePriceData(account.data)
        console.log(price)
        if (price == null) throw new Error('invalid account')

        assetsList.assets[index].price = toDecimal(
          new BN(price * 10 ** ORACLE_OFFSET),
          ORACLE_OFFSET
        )
      })
    )

    return new Prices(connection, assetsList)
  }
}
