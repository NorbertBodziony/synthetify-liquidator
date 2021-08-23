import { Connection, PublicKey } from '@solana/web3.js'
import { parsePriceData } from '@pythnetwork/client'
import { AssetsList } from '@synthetify/sdk/lib/exchange'
import { BN } from '@project-serum/anchor'
import { ORACLE_OFFSET } from '@synthetify/sdk'

export class Prices {
  private connection: Connection
  private oracles: PublicKey[]
  private scale = ORACLE_OFFSET
  public prices: BN[]

  constructor(connection: Connection, assetsList: AssetsList) {
    this.connection = connection
    this.oracles = assetsList.assets.map(({ feedAddress }) => feedAddress)
    this.prices = [...this.oracles.map(() => new BN(0))]
    this.prices[0] = new BN(1)

    this.oracles.forEach((feedAddress, index) => {
      if (index === 0) return
      connection.onAccountChange(feedAddress, (accountInfo) => {
        const { price } = parsePriceData(accountInfo.data)
        this.prices[index] = new BN(price)
      })
    })
  }
}
