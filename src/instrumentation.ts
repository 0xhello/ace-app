/**
 * Server boot hook. Node-only scheduling lives in @/lib/research-scheduler and is
 * imported ONLY under the nodejs runtime guard, so the edge bundle never pulls in
 * child_process. See that module for what gets scheduled.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/research-scheduler");
  }
}
