/** Public Worker shutdown: no route can reach a provider, KV, or retained generation code. */
export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if ((path === "/" || path === "/health") && request.method === "GET") {
      return Response.json({ ok: true, service: "nemesis-forge", mode: "offline" });
    }
    return Response.json({ error: "service disabled" }, { status: 410 });
  },
} satisfies ExportedHandler;
