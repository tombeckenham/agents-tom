/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = {
  TestAguiAgent: DurableObjectNamespace;
  ToolApprovalAguiAgent: DurableObjectNamespace;
};

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}
