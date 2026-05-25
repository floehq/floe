import { getRedis, initRedis } from "./apps/api/src/state/redis.js";

async function listKeys() {
  try {
    await initRedis();
    const redis = getRedis();
    const keys = await redis.keys("upload:*");
    console.log("Upload keys:", keys);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

listKeys();
