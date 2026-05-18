import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";

// ---------------------------------------------------------------------------
// Configuration (all optional — defaults to pass-through from CC Switch)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.CONVERTER_PORT || "11888", 10);
const HOST = process.env.CONVERTER_HOST || "127.0.0.1";

const DEEPSEEK_BASE = (
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
).replace(/\/+$/, "");

// Optional: override API key. If not set, the Authorization header from
// CC Switch is forwarded as-is to DeepSeek.
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

// Optional: model name mapping. If not set, model names pass through as-is.
// Format: "codex_model:deepseek_model,..."
const MODEL_MAP = new Map(
  (process.env.MODEL_MAP || "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [from, to] = entry.split(":");
      return [from.trim(), to.trim()];
    })
);

// Parameters that DeepSeek doesn't support — always stripped
const STRIP_PARAMS = new Set([
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "parallel_tool_calls",
  "service_tier",
  "modalities",
  "audio",
  "reasoning",
  "metadata",
  "store",
  "stream_options",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapModel(model) {
  if (MODEL_MAP.size === 0) return model;
  return MODEL_MAP.get(model) || model;
}

function stripUnsupported(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of STRIP_PARAMS) {
    delete obj[key];
  }
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function extractApiKey(req) {
  // Use explicit override if configured
  if (DEEPSEEK_API_KEY) return DEEPSEEK_API_KEY;

  // Otherwise forward the Authorization header from CC Switch as-is
  const auth = req.headers["authorization"] || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function makeDeepSeekRequest(method, path, apiKey, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, DEEPSEEK_BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: headers["accept"] || "application/json",
        "User-Agent": "ccswitch-deepseek-converter/1.0",
      },
      timeout: 600_000,
    };

    const proxyReq = https.request(opts, (proxyRes) => {
      resolve(proxyRes);
    });

    proxyReq.on("error", reject);
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      reject(new Error("DeepSeek request timeout"));
    });

    if (body) {
      proxyReq.write(JSON.stringify(body));
    }
    proxyReq.end();
  });
}

// ---------------------------------------------------------------------------
// Format conversion: OpenAI Responses API → Chat Completions
// ---------------------------------------------------------------------------

function responsesToChatCompletions(req) {
  const model = mapModel(req.model || "deepseek-chat");

  const messages = [];
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }
  if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (item.role && (item.content || item.content === "")) {
        messages.push({ role: item.role, content: item.content });
      }
    }
  }

  const chatReq = {
    model,
    messages,
    stream: req.stream || false,
  };

  if (req.max_output_tokens) chatReq.max_tokens = req.max_output_tokens;
  if (req.temperature != null) chatReq.temperature = req.temperature;
  if (req.top_p != null) chatReq.top_p = req.top_p;
  if (req.stop) chatReq.stop = req.stop;
  if (req.frequency_penalty != null) chatReq.frequency_penalty = req.frequency_penalty;
  if (req.presence_penalty != null) chatReq.presence_penalty = req.presence_penalty;
  if (req.tools) chatReq.tools = req.tools;
  if (req.tool_choice) chatReq.tool_choice = req.tool_choice;

  stripUnsupported(chatReq);

  return chatReq;
}

function chatCompletionToResponses(chatResp, originalModel) {
  const choice = chatResp.choices?.[0] || {};
  const msg = choice.message || {};

  const content = [];
  if (msg.content) {
    content.push({ type: "output_text", text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "function_call",
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      });
    }
  }

  return {
    id: chatResp.id || `resp_${Date.now()}`,
    object: "response",
    created_at: chatResp.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: originalModel || chatResp.model,
    output: [
      {
        type: "message",
        id: `msg_${Date.now()}`,
        role: msg.role || "assistant",
        content,
      },
    ],
    usage: chatResp.usage
      ? {
          input_tokens: chatResp.usage.prompt_tokens || 0,
          output_tokens: chatResp.usage.completion_tokens || 0,
          total_tokens: chatResp.usage.total_tokens || 0,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Streaming: Chat Completions SSE → Responses SSE
// ---------------------------------------------------------------------------

function createChatToResponsesSSETransform() {
  let buffer = "";

  return new Transform({
    writableObjectMode: false,
    readableObjectMode: false,

    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          this.push(line + "\n");
          continue;
        }

        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") {
          this.push("data: [DONE]\n\n");
          continue;
        }

        try {
          const chatEvent = JSON.parse(dataStr);
          const choice = chatEvent.choices?.[0];
          const delta = choice?.delta || {};

          const respEvent = {
            type: "response.output_text.delta",
            item_id: `msg_${Date.now()}`,
            output_index: choice?.index || 0,
            content_index: 0,
            delta: delta.content || "",
          };

          if (chatEvent.usage) {
            respEvent.usage = {
              input_tokens: chatEvent.usage.prompt_tokens || 0,
              output_tokens: chatEvent.usage.completion_tokens || 0,
              total_tokens: chatEvent.usage.total_tokens || 0,
            };
          }

          if (choice?.finish_reason) {
            respEvent.finish_reason = choice.finish_reason;
          }

          this.push(`data: ${JSON.stringify(respEvent)}\n\n`);
        } catch {
          this.push(line + "\n");
        }
      }

      callback();
    },

    flush(callback) {
      if (buffer) this.push(buffer + "\n");
      callback();
    },
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function parseUrl(req) {
  const raw = req.url || "/";
  const idx = raw.indexOf("?");
  return idx === -1 ? raw : raw.slice(0, idx);
}

async function handleModels(req, res) {
  const path = parseUrl(req);
  if (req.method !== "GET") return null;

  if (path === "/v1/models") {
    // If MODEL_MAP is configured, return mapped model IDs
    const seen = new Set();
    const data = [];
    if (MODEL_MAP.size > 0) {
      for (const [from, to] of MODEL_MAP) {
        if (!seen.has(from)) {
          data.push({ id: from, object: "model", created: 1700000000, owned_by: "ccswitch" });
          seen.add(from);
        }
        if (!seen.has(to)) {
          data.push({ id: to, object: "model", created: 1700000000, owned_by: "deepseek" });
          seen.add(to);
        }
      }
    } else {
      // Without MODEL_MAP, just report the DeepSeek models
      data.push(
        { id: "deepseek-chat", object: "model", created: 1700000000, owned_by: "deepseek" },
        { id: "deepseek-reasoner", object: "model", created: 1700000000, owned_by: "deepseek" }
      );
    }
    return jsonResponse(res, { object: "list", data });
  }

  const match = path.match(/^\/v1\/models\/(.+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const mapped = MODEL_MAP.get(id) || id;
    return jsonResponse(res, {
      id,
      object: "model",
      created: 1700000000,
      owned_by: "deepseek",
    });
  }

  return null;
}

async function handleChatCompletions(req, res) {
  if (req.method !== "POST" || parseUrl(req) !== "/v1/chat/completions") return null;

  const body = await readBody(req);
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return jsonResponse(
      res,
      { error: { message: "No API key available. Set DEEPSEEK_API_KEY or configure CC Switch provider auth.", type: "auth_error" } },
      401
    );
  }

  body.model = mapModel(body.model);
  delete body.stream_options;
  stripUnsupported(body);

  try {
    const dsRes = await makeDeepSeekRequest("POST", "/v1/chat/completions", apiKey, req.headers, body);

    if (body.stream) {
      res.writeHead(dsRes.statusCode, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      dsRes.pipe(res);
    } else {
      const chunks = [];
      dsRes.on("data", (c) => chunks.push(c));
      dsRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const data = JSON.parse(raw);
          jsonResponse(res, data, dsRes.statusCode);
        } catch {
          res.writeHead(dsRes.statusCode, dsRes.headers);
          res.end(raw);
        }
      });
    }
  } catch (err) {
    jsonResponse(res, { error: { message: err.message, type: "server_error" } }, 502);
  }

  return true;
}

async function handleResponses(req, res) {
  if (req.method !== "POST" || parseUrl(req) !== "/v1/responses") return null;

  const body = await readBody(req);
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return jsonResponse(
      res,
      { error: { message: "No API key available. Set DEEPSEEK_API_KEY or configure CC Switch provider auth.", type: "auth_error" } },
      401
    );
  }

  const chatReq = responsesToChatCompletions(body);

  try {
    const dsRes = await makeDeepSeekRequest("POST", "/v1/chat/completions", apiKey, req.headers, chatReq);

    if (body.stream) {
      res.writeHead(dsRes.statusCode, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      dsRes.pipe(createChatToResponsesSSETransform()).pipe(res);
    } else {
      const chunks = [];
      dsRes.on("data", (c) => chunks.push(c));
      dsRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const chatResp = JSON.parse(raw);
          jsonResponse(res, chatCompletionToResponses(chatResp, body.model), dsRes.statusCode);
        } catch {
          res.writeHead(dsRes.statusCode, dsRes.headers);
          res.end(raw);
        }
      });
    }
  } catch (err) {
    jsonResponse(res, { error: { message: err.message, type: "server_error" } }, 502);
  }

  return true;
}

async function handleHealth(req, res) {
  if (req.method === "GET" && (parseUrl(req) === "/health" || parseUrl(req) === "/")) {
    return jsonResponse(res, {
      status: "ok",
      deepseek_base: DEEPSEEK_BASE,
      mode: DEEPSEEK_API_KEY ? "override" : "passthrough",
      model_map: MODEL_MAP.size > 0 ? Object.fromEntries(MODEL_MAP) : "passthrough",
      uptime: process.uptime(),
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (await handleHealth(req, res)) return;
    if (await handleModels(req, res)) return;
    if (await handleChatCompletions(req, res)) return;
    if (await handleResponses(req, res)) return;

    jsonResponse(
      res,
      { error: { message: `Not found: ${req.method} ${req.url}`, type: "not_found" } },
      404
    );
  } catch (err) {
    if (!res.headersSent) {
      jsonResponse(
        res,
        { error: { message: err.message || "Internal server error", type: "server_error" } },
        500
      );
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ccswitch-deepseek-converter] http://${HOST}:${PORT}`);
  console.log(`  DeepSeek API:  ${DEEPSEEK_BASE}`);
  console.log(`  Auth mode:     ${DEEPSEEK_API_KEY ? "override (DEEPSEEK_API_KEY)" : "passthrough (CC Switch Authorization header)"}`);
  console.log(`  Model mapping: ${MODEL_MAP.size > 0 ? JSON.stringify(Object.fromEntries(MODEL_MAP)) : "passthrough (no mapping)"}`);
});
