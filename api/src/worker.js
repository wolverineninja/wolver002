const ALLOW_HEADERS = "Content-Type, x-anthropic-key";

function corsHeaders(origin, allowed) {
  const ok =
    origin === allowed ||
    origin === "https://www.wolver002.com" ||
    /^chrome-extension:\/\/[a-z]+$/.test(origin || "") ||
    /^http:\/\/localhost(:\d+)?$/.test(origin || "") ||
    /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, init = {}, cors = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...cors,
      ...(init.headers || {}),
    },
  });
}

const HITS = new Map();
function rateLimit(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length <= max;
}

async function callLlama(ai, messages) {
  const turns = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
    content: m.content,
  }));

  const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const out = await ai.run(MODEL, {
    messages: turns,
    max_tokens: 1024,
    temperature: 0.7,
  });

  const reply = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
  return { reply, model: MODEL };
}

async function callVision(ai, dataUrl, prompt) {
  const commaIdx = (dataUrl || "").indexOf(",");
  if (commaIdx < 0) throw new Error("invalid_image_data_url");
  const base64 = dataUrl.slice(commaIdx + 1);
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

  const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
  const out = await ai.run(MODEL, {
    image: Array.from(bytes),
    prompt:
      prompt ||
      "Look at this screenshot. If a question is visible, answer it briefly. Otherwise describe what's on screen in 1-2 short sentences. Be concise.",
    max_tokens: 512,
  });

  const reply =
    out?.description ?? out?.response ?? out?.choices?.[0]?.message?.content ?? "";
  return { reply: reply.trim(), model: MODEL };
}

async function callClaude(apiKey, messages) {
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    throw new Error("invalid_anthropic_key");
  }
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: turns,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`claude ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  const reply = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { reply, model: data.model };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() }, {}, cors);
    }

    if (url.pathname === "/vision" && request.method === "POST") {
      const ip =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("x-forwarded-for") ||
        "unknown";
      if (!rateLimit(ip)) {
        return json({ error: "rate_limited" }, { status: 429 }, cors);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_json" }, { status: 400 }, cors);
      }
      if (!body?.image) {
        return json({ error: "missing_image" }, { status: 400 }, cors);
      }
      if (typeof body.image !== "string" || body.image.length > 4_000_000) {
        return json({ error: "image_too_large" }, { status: 413 }, cors);
      }
      try {
        const out = await callVision(env.AI, body.image, body.prompt);
        return json(out, {}, cors);
      } catch (e) {
        return json(
          { error: "upstream_failed", detail: String(e.message || e) },
          { status: 502 },
          cors,
        );
      }
    }

    // ── Steam manifest proxy ──────────────────────────────────────
    // GET /manifest/{depotId}_{manifestId}.manifest
    const manifestMatch = url.pathname.match(/^\/manifest\/(\d+_\d+\.manifest)$/);
    if (manifestMatch && request.method === "GET") {
      const filename = manifestMatch[1];
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateLimit(ip, 30)) {
        return json({ error: "rate_limited" }, { status: 429 }, cors);
      }

      // Try sources in order
      const sources = [
        `https://wolver002.com/manifests/${filename}`,
        `https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main/${filename}`,
      ];

      for (const src of sources) {
        try {
          const r = await fetch(src);
          if (r.ok) {
            const body = await r.arrayBuffer();
            if (body.byteLength > 0) {
              return new Response(body, {
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Disposition": `attachment; filename="${filename}"`,
                  "Cache-Control": "public, max-age=86400",
                  ...cors,
                },
              });
            }
          }
        } catch {}
      }

      return json({ error: "manifest_not_found", filename }, { status: 404 }, cors);
    }

    // ── Steam app depot lookup ──────────────────────────────────
    // GET /steam/depots/{appId}
    const depotMatch = url.pathname.match(/^\/steam\/depots\/(\d+)$/);
    if (depotMatch && request.method === "GET") {
      const appId = depotMatch[1];
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateLimit(ip, 10)) {
        return json({ error: "rate_limited" }, { status: 429 }, cors);
      }

      try {
        const r = await fetch(`https://api.steamcmd.net/v1/info/${appId}`);
        const data = await r.json();

        if (data.status !== "success" || !data.data?.[appId]) {
          return json({ error: "app_not_found" }, { status: 404 }, cors);
        }

        const appData = data.data[appId];
        const name = appData.common?.name || `App ${appId}`;
        const depots = appData.depots || {};
        const entries = [];

        for (const [depotId, depot] of Object.entries(depots)) {
          if (!/^\d+$/.test(depotId)) continue;
          const pub = depot?.manifests?.public;
          const manifestId = typeof pub === "string" ? pub : pub?.gid;
          if (!manifestId) continue;
          entries.push({ depotId, manifestId: String(manifestId) });
        }

        return json({ name, appId, depots: entries }, {}, cors);
      } catch (e) {
        return json({ error: "lookup_failed", detail: String(e.message) }, { status: 502 }, cors);
      }
    }

    if (url.pathname !== "/chat" || request.method !== "POST") {
      return json({ error: "not_found" }, { status: 404 }, cors);
    }

    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("x-forwarded-for") ||
      "unknown";
    if (!rateLimit(ip)) {
      return json({ error: "rate_limited" }, { status: 429 }, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, { status: 400 }, cors);
    }

    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return json({ error: "missing_messages" }, { status: 400 }, cors);
    }
    const totalLen = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    if (totalLen > 12_000) {
      return json({ error: "too_long" }, { status: 413 }, cors);
    }

    const wantClaude = body.model === "claude";
    try {
      if (wantClaude) {
        const userKey = request.headers.get("x-anthropic-key");
        const out = await callClaude(userKey, messages);
        return json(out, {}, cors);
      } else {
        if (!env.AI) {
          return json(
            { error: "server_not_configured", detail: "Workers AI binding missing" },
            { status: 500 },
            cors,
          );
        }
        const out = await callLlama(env.AI, messages);
        return json(out, {}, cors);
      }
    } catch (e) {
      return json(
        { error: "upstream_failed", detail: String(e.message || e) },
        { status: 502 },
        cors,
      );
    }
  },
};
