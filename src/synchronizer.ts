import { AccountsCoder } from '@project-serum/anchor'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js'

const coder = new AccountsCoder(EXCHANGE_IDL as any)

export class Synchronizer<T> {
  private connection: Connection
  private nameInIDL: string
  public address: PublicKey
  public account: T | undefined

  constructor(connection: Connection, address: PublicKey, nameInIDL: string, initialAccount?: T) {
    this.connection = connection
    this.address = address
    this.nameInIDL = nameInIDL

    if (initialAccount) this.account = initialAccount
    else
      this.connection.getAccountInfo(this.address).then((data) => this.updateFromAccountInfo(data))

    this.connection.onAccountChange(this.address, (data) => this.updateFromAccountInfo(data))
  }

  private updateFromAccountInfo(account: AccountInfo<Buffer>) {
    this.account = coder.decode<T>(this.nameInIDL, account.data)
    // @ts-ignore: Unreachable code error
    // console.log(this.account, `account updated`)
  }
}
