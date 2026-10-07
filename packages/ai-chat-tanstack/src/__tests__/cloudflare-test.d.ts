/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = {
  TestTanstackAgent: DurableObjectNamespace;
  CancellableTanstackAgent: DurableObjectNamespace;
  ClientToolTanstackAgent: DurableObjectNamespace<
    import("./worker").ClientToolTanstackAgent
  >;
};

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}
