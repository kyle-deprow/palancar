import { G2BridgeRuntime } from "./bridge/index.js";

const runtime = new G2BridgeRuntime();

void runtime.boot().catch(() => {
  document.documentElement.dataset.palancarStatus = "startup-error";
});
