[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/dunoil/makefun-pump-fun-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/dunoil/makefun-pump-fun-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint Momentum Bot

A paper-trading momentum bot for the Pump.fun Paper Sprint competition. It
buys a new bonding curve only while real buyers are pushing it up, and it gets
out fast when the push fails. Paper trading only: the replay harness supplies
market data and settles fills, so the bot never touches real funds.

## Strategy

Per curve, the bot tracks a sliding window of the last 120 slots of trade
flow: net buy SOL, buy count, distinct buyer wallets, largest single buyer
share, and price change over the window (from each trade's own post-trade
reserves).

Entry rules: net buying of at least 0.5 SOL in the window, at least 5 buys
from at least 3 distinct buyers, price up 8 to 35 percent over the window,
curve age at least 10 slots, real SOL in the curve between 1 and 40 SOL, and
largest single buyer share below 40 percent. One new buy per batch, fixed
stake of 0.05 SOL per position, at most 3 open positions, and the fixed stake
must fit inside the harness buy size cap for the mint.

Exit rules: stop-loss at 85 percent of entry value, a trailing stop that arms
once the position reaches 130 percent of entry value and then sells if value
falls to 85 percent of its best value, and a time limit of 600 slots. Exits
run before entries each batch, and a completed curve is sold out of.

The bot is deterministic by construction: no clock, no randomness, and
iteration only over insertion-ordered maps fed by the batch stream. All
parameters live in one commented `PARAMS` object in `strategy.ts`.

## Smoke test

`tools/smoke.ts` builds synthetic batches and checks the strategy:

```
PASS rising curve gets a buy
PASS flat curve gets no buy
PASS dumping curve gets no buy
PASS dominant buyer curve gets no buy
PASS stop-loss setup: rising curve bought first
PASS stop-loss sells after price falls (sold 1666666666 tokens)
SMOKE ALL PASS
```

## Run

The grader runs `node main.ts` on Node 22. To run the smoke test locally:

```
node tools/smoke.ts
```

To sanity check the strategy import:

```
node -e "import('./strategy.ts').then(m => console.log(Object.keys(m)))"
```

## Files

- `main.ts`: thin glue, hands the strategy to the vendor `runBot` loop.
- `strategy.ts`: the momentum strategy and its parameters.
- `vendor/agentfun-bot.ts`: the kit vendor shim, copied byte for byte.
- `tools/smoke.ts`: synthetic batch smoke test.
