import type { ITransaction } from '@/lib/models/portfolio';

export interface HoldingState {
  quantity: number;
  avgBuyPrice: number;
}

export function calculateHoldingState(transactions: ITransaction[]): HoldingState {
  let quantity = 0;
  let avgBuyPrice = 0;

  for (const tx of transactions) {
    if (tx.type === 'buy') {
      const fee = tx.fee ?? 0;
      const totalCost = tx.quantity * tx.price + fee;
      const newQuantity = quantity + tx.quantity;
      avgBuyPrice = newQuantity > 0
        ? (quantity * avgBuyPrice + totalCost) / newQuantity
        : 0;
      quantity = newQuantity;
    } else {
      quantity -= tx.quantity;
    }
  }

  return {
    quantity: Math.max(0, quantity),
    avgBuyPrice: quantity > 0 ? avgBuyPrice : 0,
  };
}
