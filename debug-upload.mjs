import { getRedis, initRedis } from "./apps/api/src/state/redis.js";
import { uploadKeys } from "./apps/api/src/state/keys.js";

async function checkSession() {
  const uploadId = process.argv[2];
  if (!uploadId) {
    console.error("Missing uploadId");
    process.exit(1);
  }
  try {
    await initRedis();
    const redis = getRedis();
    const session = await redis.hgetall(uploadKeys.session(uploadId));
    const meta = await redis.hgetall(uploadKeys.meta(uploadId));
    console.log("Session for " + uploadId + ":", JSON.stringify(session, null, 2));
    console.log("Meta for " + uploadId + ":", JSON.stringify(meta, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkSession();
