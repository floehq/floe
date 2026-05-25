import { getRedis, initRedis } from "../apps/api/src/state/redis.js";
import { uploadKeys } from "../apps/api/src/state/keys.js";

async function checkSession() {
  await initRedis();
  const redis = getRedis();
  const uploadId = "32c25deb-4d9e-4566-877d-e1fd983a21a2";
  const session = await redis.hgetall(uploadKeys.session(uploadId));
  const meta = await redis.hgetall(uploadKeys.meta(uploadId));
  console.log("Session:", JSON.stringify(session, null, 2));
  console.log("Meta:", JSON.stringify(meta, null, 2));
  process.exit(0);
}

checkSession();
