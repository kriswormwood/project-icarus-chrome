// @flow

import BigNumber from 'bignumber.js';

import type {
  AdaWallet,
  AdaWallets,
  AdaWalletInitData,
  AdaWalletRecoveryPhraseResponse,
  AdaAccounts,
  AdaTransactions,
  AdaTransaction,
  AdaTransactionInputOutput
} from './types';

import {
  toWallet,
  generateAccount,
  isValidAdaMnemonic,
  generateAdaMnemonic,
} from './lib/ada-wallet';

import { Wallet } from 'cardano-crypto';
import { getWalletFromAccount } from './lib/ada-wallet';

import type { AdaTxFeeParams } from './adaTxFee';

import { getInfo, getTxInfo } from './lib/explorer-api';
import { syncStatus, getUTXOsOfAddress, sendTx } from './lib/cardano-sl-api';

const WALLET_KEY = 'WALLET'; // single wallet atm
const ACCOUNT_KEY = 'ACCOUNT'; // single account atm
const TX_KEY = 'TXS'; // single txs list atm

export type AdaWalletParams = {
  walletPassword: ?string,
  walletInitData: AdaWalletInitData
};

export type IsValidAdaAddressParams = {
  /*ca: string,*/
  address: string
};

export type GetAdaWalletAccountsParams = {
  walletId: string
};

export type GetAdaHistoryByWalletParams = {
  ca: string,
  walletId: string,
  skip: number,
  limit: number
};

export type NewAdaPaymentParams = {
  sender: string,
  receiver: string,
  amount: string,
  password: ?string,
  // "groupingPolicy" - Spend everything from the address
  // "OptimizeForSize" for no grouping
  groupingPolicy: ?'OptimizeForSecurity' | 'OptimizeForSize'
};

export const isValidAdaAddress = ({
  /*ca, */ address
}: IsValidAdaAddressParams): Promise<boolean> => Promise.resolve(true);

export const isValidMnemonic = (phrase: string, numberOfWords: number = 12) =>
  isValidAdaMnemonic(phrase, numberOfWords);

export async function newAdaWallet({
  walletPassword,
  walletInitData
}: AdaWalletParams): Promise<AdaWallet> {
  const wallet = toWallet({ walletPassword, walletInitData });
  saveInStorage(WALLET_KEY, wallet);
  const mnemonic = walletInitData.cwBackupPhrase.bpToList;
  const account = generateAccount(mnemonic, walletPassword);
  saveInStorage(ACCOUNT_KEY, account);
  return Promise.resolve(wallet);
}

export const restoreAdaWallet = ({
  walletPassword,
  walletInitData
}: AdaWalletParams): Promise<AdaWallet> =>
  newAdaWallet({ walletPassword, walletInitData });

export const getAdaWallets = async (): Promise<AdaWallets> => {
  const persistentWallet = getFromStorage(WALLET_KEY);
  if (!persistentWallet) return Promise.resolve([]);

  const account = getFromStorage(ACCOUNT_KEY);
  const accountResponse = await getInfo(account.address);

  const updatedWallet = Object.assign({}, persistentWallet, {
    cwAmount: {
      getCCoin: accountResponse.caBalance.getCoin
    }
  });
  saveInStorage(WALLET_KEY, updatedWallet);
  if (accountResponse.caTxList.length > 0) {
    const txRequests = accountResponse.caTxList.map(({ ctbId }) =>
      getTxInfo(ctbId)
    );
    const [syncStatusResponse, ...txsResponse] = await Promise.all(
      [syncStatus()].concat(txRequests)
    );

    const latestBlockNumber =
      syncStatusResponse._spNetworkCD.getChainDifficulty.getBlockCount;

    saveInStorage(
      TX_KEY,
      mapTransactions(txsResponse, account.address, latestBlockNumber)
    );
  }

  return Promise.resolve([updatedWallet]);
};

export const getAdaAccountRecoveryPhrase = (): AdaWalletRecoveryPhraseResponse =>
  generateAdaMnemonic();

export const getAdaWalletAccounts = ({
  walletId
}: GetAdaWalletAccountsParams): Promise<AdaAccounts> => {
  const account = getFromStorage(ACCOUNT_KEY);
  if (!account) return Promise.resolve([]);
  const adaAccount = {
    caAddresses: [
      {
        cadAmount: {
          getCCoin: 0
        }, // FIXME: Fetch data from the server
        cadId: account.address,
        cadIsUsed: false
      }
    ],
    caAmount: {
      getCCoin: 0
    },
    caId: account.address,
    caMeta: {
      caName: 'caName'
    }
  };
  return Promise.resolve([adaAccount]);
};

export const getAdaHistoryByWallet = ({
  walletId,
  skip,
  limit
}: GetAdaHistoryByWalletParams): Promise<AdaTransactions> => {
  const transactions = getFromStorage(TX_KEY);
  if (!transactions) return Promise.resolve([[], 0]);

  return Promise.resolve([transactions, transactions.length]);
};

export const getPaymentFee = ({
  sender,
  receiver,
  amount,
  groupingPolicy
}: AdaTxFeeParams): Promise<Number> => {
  // FIXME: get the correct fee
  return Promise.resolve(0);
};

export const newAdaPayment = ({
  sender,
  receiver,
  amount,
  groupingPolicy,
  password
}: NewAdaPaymentParams): Promise<AdaTransaction> => {
  const account = getFromStorage(ACCOUNT_KEY);
  const wallet = getWalletFromAccount(account, password);
  // FIXME: Remove feeAddr
  const feeAddr = sender;
  const changeAddr = sender;
  const outputs = [{ address: receiver, value: parseInt(amount, 10) }];
  return getUTXOsOfAddress(sender) // TODO: Manage multiple sender addresses
    .then((senderUtxos) => {
      const signedTx = Wallet.spend(
        wallet,
        senderUtxos,
        outputs,
        feeAddr,
        changeAddr
      ).result.cbor_encoded_tx;
      // TODO: Target to icaraus-backend-service method
      return sendTx(signedTx);
    });
};

/**
 * Private method helpers
 */

function saveInStorage(key: string, toSave: any): void {
  localStorage.setItem(key, JSON.stringify(toSave));
}

function getFromStorage(key: string): any {
  const result = localStorage.getItem(key);
  if (result) return JSON.parse(result);
  return undefined;
}

function mapTransactions(
  transactions: [],
  accountAddress,
  latestBlockNumber
): Array<AdaTransaction> {
  return transactions.map(tx => {
    const { isOutgoing, amount } = spenderData(tx, accountAddress);
    const isPending = tx.ctsBlockHeight == null;
    return {
      ctAmount: {
        getCCoin: amount
      },
      ctConfirmations: isPending ? 0 : latestBlockNumber - tx.ctsBlockHeight,
      ctId: tx.ctsId,
      ctInputs: tx.ctsInputs.map(mapInputOutput),
      ctIsOutgoing: isOutgoing,
      ctMeta: {
        ctmDate: tx.ctsTxTimeIssued,
        ctmDescription: undefined,
        ctmTitle: undefined
      },
      ctOutputs: tx.ctsOutputs.map(mapInputOutput),
      ctCondition: isPending ? 'CPtxApplying' : 'CPtxInBlocks'
    };
  });
}

function mapInputOutput(txInput): AdaTransactionInputOutput {
  return [
    txInput[0],
    {
      getCCoin: txInput[1].getCoin
    }
  ];
}

function spenderData(tx, address) {
  const sum = toSum =>
    toSum.reduce(
      ({ totalAmount, count }, val) => {
        if (val[0] !== address) return { totalAmount, count };
        return {
          totalAmount: totalAmount.plus(new BigNumber(val[1].getCoin)),
          count: count + 1
        };
      },
      {
        totalAmount: new BigNumber(0),
        count: 0
      }
    );

  const incoming = sum(tx.ctsOutputs);
  const outgoing = sum(tx.ctsInputs);

  const isOutgoing = outgoing.totalAmount.greaterThanOrEqualTo(
    incoming.totalAmount
  );

  const isLocal =
    incoming.length === tx.ctsInputs.length &&
    outgoing.length === tx.ctsOutputs.length;

  let amount;
  if (isLocal) amount = outgoing.totalAmount;
  else if (isOutgoing) amount = outgoing.totalAmount - incoming.totalAmount;
  else amount = incoming.totalAmount - outgoing.totalAmount;

  return {
    isOutgoing,
    amount
  };
}