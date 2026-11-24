// Pump.fun Paper Sprint momentum bot.
//
// Idea: buy a new bonding curve only while real buyers are pushing it up,
// and get out fast when the push fails. Every decision comes from the batch
// stream alone, so the bot is deterministic: no clock, no randomness, and
// iteration only over insertion-ordered maps fed by the batches.
//
// Entry: a curve whose recent trade flow shows strong net buying, several
// distinct buyers, and a healthy but not overheated price rise, with guards
// against brand-new curves, thin or bloated curves, and one dominant buyer.
// Exit: a stop-loss, a trailing stop once the position has run up enough to
// arm it, or a time limit in slots, whichever comes first.

import type { Batch, Bot, BotState, OrderInput } from './vendor/agentfun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/agentfun-bot.ts';

export interface StrategyParams {
  // Sliding window of recent trade flow, in slots.
  windowSlots: number;
  // Minimum net buying inside the window, in SOL.
  minNetBuySol: number;
  // Minimum number of buy trades inside the window.
  minBuyCount: number;
  // Minimum number of distinct buyer wallets inside the window.
  minDistinctBuyers: number;
  // Minimum price rise over the window, as a fraction (0.08 is 8 percent).
  minPriceRise: number;
  // Maximum price rise over the window: above this the move is already spent.
  maxPriceRise: number;
  // Minimum curve age at entry, in slots.
  minAgeSlots: number;
  // Real SOL in the curve must sit inside this band at entry.
  minRealSol: number;
  maxRealSol: number;
  // Largest single buyer share of window buy volume: above this, skip.
  maxTopBuyerShare: number;
  // Fixed stake per position, in lamports.
  stakeLamports: bigint;
  // Maximum open positions (held plus buys pending).
  maxOpenPositions: number;
  // Sell when the position value falls to this fraction of entry value.
  stopLossRatio: number;
  // Arm the trailing stop once value reaches this multiple of entry value.
  trailArmRatio: number;
  // Once armed, sell when value falls to this fraction of its best value.
  trailDropRatio: number;
  // Maximum holding time, in slots from entry.
  maxHoldSlots: number;
  // Slippage tolerance on every order, in basis points.
  maxSlippageBps: number;
}

// Plain, defensible values. The stake is small on purpose: on a 6-hour
// window of fresh pump.fun curves, most entries lose a little and a few run,
// so survival comes from fixed small size and fast exits, not from sizing up.
export const DEFAULT_PARAMS: StrategyParams = {
  windowSlots: 120,
  minNetBuySol: 0.5,
  minBuyCount: 5,
  minDistinctBuyers: 3,
  minPriceRise: 0.08,
  maxPriceRise: 0.35,
  minAgeSlots: 10,
  minRealSol: 1,
  maxRealSol: 40,
  maxTopBuyerShare: 0.4,
  stakeLamports: 50_000_000n, // 0.05 SOL per position.
  maxOpenPositions: 3,
  stopLossRatio: 0.85,
  trailArmRatio: 1.3,
  trailDropRatio: 0.85,
  maxHoldSlots: 600,
  maxSlippageBps: 500,
};

interface FlowTrade {
  slot: number;
  solLamports: bigint;
  isBuy: boolean;
  user: string;
  price: number;
}

interface CurveFlow {
  trades: FlowTrade[];
}

interface EntryInfo {
  entryPrice: number;
  bestRatio: number;
  entrySlot: number;
  armed: boolean;
}

interface WindowStats {
  netBuyLamports: bigint;
  buyCount: number;
  distinctBuyers: number;
  topBuyerShare: number;
  priceRise: number;
}

/** Price of one token in SOL, from virtual reserves. Zero when unknown. */
function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  if (curve.virtual_token_reserves <= 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS): Bot {
  const flows = new Map<string, CurveFlow>();
  const entries = new Map<string, EntryInfo>();
  const pendingBuys = new Map<string, EntryInfo>();

  function flowFor(mint: string): CurveFlow {
    let flow = flows.get(mint);
    if (flow === undefined) {
      flow = { trades: [] };
      flows.set(mint, flow);
    }
    return flow;
  }

  function statsFor(mint: string, slot: number): WindowStats | null {
    const flow = flows.get(mint);
    if (flow === undefined || flow.trades.length === 0) return null;
    const cutoff = slot - params.windowSlots;
    const window = flow.trades.filter((t) => t.slot >= cutoff);
    if (window.length === 0) return null;
    let netBuy = 0n;
    let buyVolume = 0n;
    let buyCount = 0;
    const buyers = new Set<string>();
    const perBuyer = new Map<string, bigint>();
    for (const trade of window) {
      if (trade.isBuy) {
        netBuy += trade.solLamports;
        buyVolume += trade.solLamports;
        buyCount += 1;
        buyers.add(trade.user);
        perBuyer.set(trade.user, (perBuyer.get(trade.user) ?? 0n) + trade.solLamports);
      } else {
        netBuy -= trade.solLamports;
      }
    }
    let topBuyer = 0n;
    for (const volume of perBuyer.values()) {
      if (volume > topBuyer) topBuyer = volume;
    }
    const firstPrice = window[0].price;
    const lastPrice = window[window.length - 1].price;
    const priceRise = firstPrice > 0 ? (lastPrice - firstPrice) / firstPrice : 0;
    return {
      netBuyLamports: netBuy,
      buyCount,
      distinctBuyers: buyers.size,
      topBuyerShare: buyVolume > 0n ? Number(topBuyer) / Number(buyVolume) : 1,
      priceRise,
    };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];

      // 1. Ingest this batch's events into the per-curve flow windows.
      for (const event of batch.events) {
        if (event.event === 'CreateEvent') {
          flowFor(event.mint);
        } else if (event.event === 'TradeEvent') {
          // Price from this trade's own post-trade reserves, not the curve's
          // current reserves: every trade in one batch would otherwise share
          // one price and the window price rise would always read zero.
          const tokenReserves = BigInt(event.virtual_token_reserves);
          const price = tokenReserves > 0n
            ? Number(event.virtual_quote_reserves) / Number(tokenReserves)
            : 0;
          flowFor(event.mint).trades.push({
            slot: event.slot,
            solLamports: BigInt(event.sol_amount),
            isBuy: event.is_buy,
            user: event.user,
            price,
          });
        }
      }
      // Prune trades that fell out of the window, oldest first.
      const cutoff = batch.slot - params.windowSlots;
      for (const flow of flows.values()) {
        while (flow.trades.length > 0 && flow.trades[0].slot < cutoff) {
          flow.trades.shift();
        }
      }

      // 2. Promote filled buys into tracked entries, then run exits first so
      // a position never gets a fresh buy while it should be sold.
      for (const mint of [...state.positions.keys()]) {
        const pending = pendingBuys.get(mint);
        if (pending !== undefined && !entries.has(mint)) {
          entries.set(mint, pending);
          pendingBuys.delete(mint);
        }
      }
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          if (holding.token_amount > 0n) {
            orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: params.maxSlippageBps });
          }
          entries.delete(mint);
          continue;
        }
        const price = priceOf(curve);
        if (price <= 0) continue;
        let info = entries.get(mint);
        if (info === undefined) {
          info = { entryPrice: price, bestRatio: 1, entrySlot: batch.slot, armed: false };
          entries.set(mint, info);
        }
        const ratio = price / info.entryPrice;
        if (ratio > info.bestRatio) info.bestRatio = ratio;
        if (info.bestRatio >= params.trailArmRatio) info.armed = true;
        const stopHit = ratio <= params.stopLossRatio;
        const trailHit = info.armed && ratio <= info.bestRatio * params.trailDropRatio;
        const timedOut = batch.slot - info.entrySlot >= params.maxHoldSlots;
        if (stopHit || trailHit || timedOut) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: params.maxSlippageBps });
          entries.delete(mint);
        }
      }
      // Drop entry records for positions that are gone.
      for (const mint of [...entries.keys()]) {
        if (!state.positions.has(mint)) entries.delete(mint);
      }

      // 3. Entries: at most one new buy per batch, in first-seen curve order.
      if (state.committedPositionCount() >= params.maxOpenPositions) return orders;
      if (state.freeCashLamports() < params.stakeLamports + state.txFeeLamports()) return orders;
      for (const [mint, curve] of state.curves) {
        if (orders.some((o) => o.side === 'buy')) break;
        if (curve.complete) continue;
        if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
        if (curve.created_slot === null) continue;
        if (batch.slot - curve.created_slot < params.minAgeSlots) continue;
        const realSol = Number(curve.real_quote_reserves) / Number(LAMPORTS_PER_SOL);
        if (realSol < params.minRealSol || realSol > params.maxRealSol) continue;
        const price = priceOf(curve);
        if (price <= 0) continue;
        const stats = statsFor(mint, batch.slot);
        if (stats === null) continue;
        if (stats.netBuyLamports < BigInt(Math.round(params.minNetBuySol * 1_000_000_000))) continue;
        if (stats.buyCount < params.minBuyCount) continue;
        if (stats.distinctBuyers < params.minDistinctBuyers) continue;
        if (stats.priceRise < params.minPriceRise || stats.priceRise > params.maxPriceRise) continue;
        if (stats.topBuyerShare > params.maxTopBuyerShare) continue;
        // The buy size cap for this mint must admit the fixed stake.
        if (state.maxBuyLamports(mint) < params.stakeLamports) continue;
        orders.push({ side: 'buy', mint, quote_lamports: params.stakeLamports, max_slippage_bps: params.maxSlippageBps });
        pendingBuys.set(mint, { entryPrice: price, bestRatio: 1, entrySlot: batch.slot, armed: false });
      }
      return orders;
    },
  };
}
