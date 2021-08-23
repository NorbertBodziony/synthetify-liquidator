import { Connection, PublicKey } from '@solana/web3.js'
import { parseMappingData, parsePriceData, parseProductData } from '@pythnetwork/client'
import { AssetsList } from '@synthetify/sdk/lib/exchange'

export const prices = async (connection: Connection, assetsList: AssetsList) => {
  const asset = assetsList.assets[3]

  connection.onAccountChange(asset.feedAddress, (accountInfo) => {
    const data = parsePriceData(accountInfo.data)

    console.log(data.price)
  })
}
