import { Connection, PublicKey } from '@solana/web3.js'
import { parsePriceData } from '@pythnetwork/client'
import { AssetsList } from '@synthetify/sdk/lib/exchange'
import { BN } from '@project-serum/anchor'
import { ORACLE_OFFSET } from '@synthetify/sdk'

export class Prices {
  private connection: Connection
  private oracles: PublicKey[]
  private scale = ORACLE_OFFSET
  public initializationPromise: Promise<void[]>
  public prices: BN[]

  constructor(connection: Connection, assetsList: AssetsList) {
    this.connection = connection
    this.oracles = assetsList.assets.map(({ feedAddress }) => feedAddress)
    this.prices = [...this.oracles.map(() => new BN(0))]

    // Initialize prices (for assets with constant prices)
    this.initializationPromise = Promise.all(
      this.oracles.map(async (feedAddress, index) => {
        if (index === 0) {
          this.prices[index] = new BN(10 ** this.scale)
          return
        }

        const { data } = await this.connection.getAccountInfo(feedAddress)
        const { price } = parsePriceData(data)
        this.prices[index] = new BN(price * 10 ** this.scale)
      })
    )

    // Subscribe to oracle updates
    this.oracles.forEach((feedAddress, index) => {
      connection.onAccountChange(feedAddress, (accountInfo) => {
        const { price } = parsePriceData(accountInfo.data)
        this.prices[index] = new BN(price * 10 ** this.scale)
      })
    })
  }
}
