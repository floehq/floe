import { getRedis, initRedis } from "./apps/api/src/state/redis.js";
import { uploadKeys } from "./apps/api/src/state/keys.js";

async function checkSession() {
  try {
    await initRedis();
    const redis = getRedis();
    const uploadId = "8d2c1354-dece-4959-a345-8ca7ecf683da";
    const session = await redis.hgetall(uploadKeys.session(uploadId));
    console.log("Session for " + uploadId + ":", JSON.stringify(session, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkSession();
