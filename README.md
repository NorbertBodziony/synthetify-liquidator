# Liquidator

## installation 

Install dependencies using npm:

    npm i 
    
also, **ts-node** has to be installed globally.

Script uses keypair set in Solana [config](https://docs.solana.com/cli/choose-a-cluster#configure-the-command-line-tool) and creates accounts on needed tokens. 
To liquidate a user xUSD is needed.
    
   
## Usage

To run script use:

    npm start
    
 or:
 
    ts-node ./src/index.ts
  
  
## How it works

The script downloads all _Exchange Accounts_ (and updates when they change) to find ones that are at risk of liquidation. 
If *liquidation_deadline* comes they are liquidated using funds from a local wallet.
