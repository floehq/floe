import { bootstrapRuntimeConfig } from "./config/runtime.bootstrap.js";

await bootstrapRuntimeConfig();

const { start } = await import("./app.server.js");

await start();
