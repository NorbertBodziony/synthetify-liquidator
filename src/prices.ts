import { Connection, PublicKey } from '@solana/web3.js'
import { parseMappingData, parsePriceData, parseProductData } from '@pythnetwork/client'
import { AssetsList } from '@synthetify/sdk/lib/exchange'

export const prices = async (connection: Connection, assetsList: AssetsList) => {
  const asset = assetsList.assets[3]

  //   const unparsed = await connection.getAccountInfo(asset.feedAddress)
  //   const data = parsePriceData(unparsed.data)
  //   console.log(data.price)

  //   allAssets.forEach((asset, index) => {
  //     connection.onAccountChange(asset.feedAddress, (accountInfo) => {
  //       const data = parsePriceData(accountInfo.data)
  //       dispatch(
  //         actions.setAssetPrice({
  //           tokenIndex: index,
  //           price: { val: new BN(data.price * 10 ** asset.price.scale), scale: asset.price.scale }
  //         })
  //       )
  //     })
  //   })

  const accountInfo = await connection.getAccountInfo(asset.feedAddress)
  const data = parsePriceData(accountInfo.data)
  console.log(data.price)
}
