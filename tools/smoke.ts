// Smoke test for the momentum strategy, using synthetic batches only.
// It builds four curves (rising, flat, dumping, one dominant buyer), feeds
// them to a fresh strategy through BotState, and checks the buy/skip calls.
// A fifth step checks the stop-loss exit after an entry. Run with:
//   node tools/smoke.ts

import { BotState } from '../vendor/agentfun-bot.ts';
import type { Batch, Hello } from '../vendor/agentfun-bot.ts';
import { createStrategy } from '../strategy.ts';

const TOKEN_RESERVES = '1000000000000'; // 1e12 virtual tokens, constant.
const SOL = 1_000_000_000n;

const RISE_MINT = 'Rise1111111111111111111111111111';
const FLAT_MINT = 'Flat1111111111111111111111111111';
const DUMP_MINT = 'Dump1111111111111111111111111111';
const WHALE_MINT = 'Whal1111111111111111111111111111';

function hello(): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '1',
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 1, residue: 0 },
    },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 5000, max_orders_per_batch: 10, shorts: false, leverage: false },
    latency_slots: 1,
    fees: { protocol_bps_fallback: 0, creator_bps_fallback: 0, base_fee_lamports: '5000', priority_fee_lamports: '0', failed_tx_bps: 0 },
  } as Hello;
}

function createEvent(mint: string, slot: number): Record<string, unknown> {
  return {
    event: 'CreateEvent', mint, slot, signature: `sig-create-${slot}`, block_time: null, chain_seq: 0,
    name: 'Test', symbol: 'TEST', uri: 'https://example.invalid/t', bonding_curve: mint,
    user: 'Creator111111111111111111111111111', creator: 'Creator111111111111111111111111111',
    timestamp: '0', virtual_token_reserves: TOKEN_RESERVES, virtual_sol_reserves: '30000000000',
    real_token_reserves: TOKEN_RESERVES, token_total_supply: TOKEN_RESERVES,
    token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    is_mayhem_mode: false, is_cashback_enabled: false, quote_mint: 'So11111111111111111111111111111111111111112',
    virtual_quote_reserves: '30000000000', creator_fee_bps: '0', is_holder_reward: false, depth: 0,
  };
}

// One trade on a curve. quoteSol sets the post-trade virtual SOL reserves,
// which sets the price the strategy sees for this trade.
function tradeEvent(mint: string, slot: number, seq: number, user: string, isBuy: boolean, solLamports: bigint, quoteSol: number): Record<string, unknown> {
  const quote = String(BigInt(Math.round(quoteSol * 1_000_000_000)));
  return {
    event: 'TradeEvent', mint, slot, signature: `sig-${mint.slice(0, 4)}-${seq}`, block_time: null, chain_seq: seq,
    sol_amount: solLamports.toString(), token_amount: '1000000', is_buy: isBuy, user, timestamp: '0',
    virtual_sol_reserves: quote, virtual_token_reserves: TOKEN_RESERVES,
    real_sol_reserves: '10000000000', real_token_reserves: TOKEN_RESERVES,
    fee_recipient: 'Fee11111111111111111111111111111111', fee_basis_points: '0', fee: '0',
    creator: 'Creator111111111111111111111111111', creator_fee_basis_points: '0', creator_fee: '0',
    track_volume: true, total_unclaimed_tokens: '0', total_claimed_tokens: '0', current_sol_volume: '0',
    last_update_timestamp: '0', ix_name: 'buy', mayhem_mode: false, cashback_fee_basis_points: '0',
    cashback: '0', buyback_fee_basis_points: '0', buyback: '0', shareholders: [],
    quote_mint: 'So11111111111111111111111111111111111111112', quote_amount: solLamports.toString(),
    virtual_quote_reserves: quote, real_quote_reserves: '10000000000',
    holder_rewards_bps: '0', holder_rewards: '0', creator_fee_unclaimed: '0',
  };
}

function batch(seq: number, slot: number, events: Record<string, unknown>[], positions: { mint: string; token_amount: string; cost_lamports: string }[] = []): Batch {
  return {
    type: 'batch', seq, slot,
    events: events as unknown as Batch['events'],
    marks: [], fills: [],
    account: { cash_lamports: '10000000000', positions },
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function runCurve(mint: string, steps: { slot: number; user: string; isBuy: boolean; sol: number; quoteSol: number }[]): Promise<ReturnType<BotState['toOrders']>[]> {
  const state = new BotState(hello());
  const bot = createStrategy();
  const allOrders: ReturnType<BotState['toOrders']>[] = [];
  let seq = 0;
  const first = batch(seq++, 0, [createEvent(mint, 0)]);
  state.applyBatch(first);
  allOrders.push(state.toOrders(await bot.onBatch(state, first)));
  for (const step of steps) {
    const b = batch(seq++, step.slot, [
      tradeEvent(mint, step.slot, seq, step.user, step.isBuy, BigInt(Math.round(step.sol * 1_000_000_000)), step.quoteSol),
    ]);
    state.applyBatch(b);
    allOrders.push(state.toOrders(await bot.onBatch(state, b)));
  }
  return allOrders;
}

function hasBuy(ordersList: ReturnType<BotState['toOrders']>[], mint: string): boolean {
  return ordersList.some((orders) => orders.some((o) => o.side === 'buy' && o.mint === mint));
}

const buyers = ['Buyer1111111111111111111111111111', 'Buyer2111111111111111111111111111', 'Buyer3111111111111111111111111111', 'Buyer4111111111111111111111111111', 'Buyer5111111111111111111111111111', 'Buyer6111111111111111111111111111'];

// 1. Rising curve: six distinct buyers, 0.2 SOL each, price 30 to 36 SOL.
const riseSteps = [20, 30, 40, 50, 60, 70].map((slot, i) => ({
  slot, user: buyers[i], isBuy: true, sol: 0.2, quoteSol: [30, 31, 32, 33, 34, 36][i],
}));
const riseOrders = await runCurve(RISE_MINT, riseSteps);
check('rising curve gets a buy', hasBuy(riseOrders, RISE_MINT));

// 2. Flat curve: same buying, price never moves.
const flatSteps = [20, 30, 40, 50, 60, 70].map((slot, i) => ({
  slot, user: buyers[i], isBuy: true, sol: 0.2, quoteSol: 30,
}));
check('flat curve gets no buy', !hasBuy(await runCurve(FLAT_MINT, flatSteps), FLAT_MINT));

// 3. Dumping curve: buying volume but the price falls 30 to 24 SOL.
const dumpSteps = [20, 30, 40, 50, 60, 70].map((slot, i) => ({
  slot, user: buyers[i], isBuy: true, sol: 0.2, quoteSol: [30, 29, 28, 27, 25, 24][i],
}));
check('dumping curve gets no buy', !hasBuy(await runCurve(DUMP_MINT, dumpSteps), DUMP_MINT));

// 4. Dominant buyer: one wallet does 5 of the buys, price still rises.
const whaleSteps = [
  { slot: 20, user: buyers[0], isBuy: true, sol: 0.2, quoteSol: 30 },
  { slot: 30, user: buyers[0], isBuy: true, sol: 0.2, quoteSol: 31 },
  { slot: 40, user: buyers[0], isBuy: true, sol: 0.2, quoteSol: 32 },
  { slot: 50, user: buyers[0], isBuy: true, sol: 0.2, quoteSol: 33 },
  { slot: 60, user: buyers[0], isBuy: true, sol: 0.2, quoteSol: 34 },
  { slot: 70, user: buyers[1], isBuy: true, sol: 0.05, quoteSol: 35 },
  { slot: 80, user: buyers[2], isBuy: true, sol: 0.05, quoteSol: 36 },
  { slot: 90, user: buyers[3], isBuy: true, sol: 0.05, quoteSol: 36 },
];
check('dominant buyer curve gets no buy', !hasBuy(await runCurve(WHALE_MINT, whaleSteps), WHALE_MINT));

// 5. Stop-loss: replay the rising curve, take the buy, then crash the price.
{
  const state = new BotState(hello());
  const bot = createStrategy();
  let seq = 0;
  let bought = false;
  const first = batch(seq++, 0, [createEvent(RISE_MINT, 0)]);
  state.applyBatch(first);
  await bot.onBatch(state, first);
  for (const step of riseSteps) {
    const b = batch(seq++, step.slot, [
      tradeEvent(RISE_MINT, step.slot, seq, step.user, step.isBuy, BigInt(Math.round(step.sol * 1_000_000_000)), step.quoteSol),
    ]);
    state.applyBatch(b);
    const orders = state.toOrders(await bot.onBatch(state, b));
    if (orders.some((o) => o.side === 'buy')) bought = true;
  }
  check('stop-loss setup: rising curve bought first', bought);
  // The fill lands: we now hold tokens, bought near 34 SOL of virtual reserves.
  const crash = batch(seq++, 80, [
    tradeEvent(RISE_MINT, 80, seq, buyers[0], false, 1n * SOL, 25),
  ], [{ mint: RISE_MINT, token_amount: '1666666666', cost_lamports: '50000000' }]);
  state.applyBatch(crash);
  const exitOrders = state.toOrders(await bot.onBatch(state, crash));
  const sell = exitOrders.find((o) => o.side === 'sell' && o.mint === RISE_MINT);
  check('stop-loss sells after price falls', sell !== undefined, sell === undefined ? 'no sell order' : `sold ${sell.token_amount} tokens`);
}

if (failures > 0) {
  console.log(`SMOKE ${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('SMOKE ALL PASS');
}
