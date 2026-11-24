// Pump.fun Paper Sprint momentum bot. Paper trading only: the replay harness
// supplies market data and settles fills, so this bot never touches real funds.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the vendor shim is the kit's agentfun-bot.ts, copied byte for byte. The
// strategy is deterministic by construction: it reads no clock, no
// environment, and no randomness, so repeated runs produce identical orders.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
