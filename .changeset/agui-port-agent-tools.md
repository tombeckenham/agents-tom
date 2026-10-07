---
"agents": patch
"@cloudflare/ai-chat": patch
---

Bring the AG-UI chat engine's agent-tool child adapter up to date:

- `runAgentTool({ eventDelivery: "terminal" })` is honoured by chat children: their chunks are stored for replay but not broadcast, including for a turn recovered after a restart (#2364).
- A tail seeds a cold live sequence from the stored backlog before it attaches, so a chunk broadcast while the tail drains or inspects after a restart is forwarded instead of dropped, and `inspectAgentToolRun(runId, { reconcile: false })` reads a stale run without settling it (#2384).
- A child's stream error is recorded on its open run row, so a child evicted before the run was finalized reconciles as `error` rather than `completed` (#2390).
