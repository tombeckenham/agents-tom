/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference types="vite/client" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}
