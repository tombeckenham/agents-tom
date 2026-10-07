/* eslint-disable */
interface __BaseEnv_Env {
  AI: Ai;
  ChatAgent: DurableObjectNamespace<import("./src/server").ChatAgent>;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "ChatAgent";
  }
  interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
