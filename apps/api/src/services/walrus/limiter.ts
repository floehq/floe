import PQueue from "p-queue";
import { WalrusQueueLimits } from "../../config/walrus.config.js";

export const walrusQueue = new PQueue({
  concurrency: WalrusQueueLimits.concurrency,
  intervalCap: WalrusQueueLimits.intervalCap,
  interval: WalrusQueueLimits.intervalMs,
  carryoverConcurrencyCount: true,
});
