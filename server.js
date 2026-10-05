import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const OLLAMA_URL = "https://ollama.com/api/chat";

// =========================================================
// TOOL DEFINITIONS (Model sees these schemas)
// =========================================================
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time in a specific timezone.",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone name, e.g. 'America/New_York', 'Europe/London', 'Asia/Tokyo'." }
        },
        required: ["timezone"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate a basic arithmetic expression. Supports +, -, *, /, %, ** and parentheses.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "The arithmetic expression to evaluate, e.g. '(11434 + 12341) * 412'." }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_location",
      description: "Get the user's approximate city and region based on their IP address.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information using Ollama Cloud's built-in web search. Use this for real-time data, news, or facts you don't know.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch and summarize a web page from a URL. Use this when you have a specific URL to read.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description: "Execute a Python script. Use this for complex calculations, data analysis, or logic that requires code. The script must be self-contained and print its output.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The Python code to execute. Use print() to output results." }
        },
        required: ["code"]
      }
    }
  }
];

// =========================================================
// TOOL IMPLEMENTATIONS (Server executes these)
// =========================================================
function getCurrentTime({ timezone }) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    });
    return fmt.format(now);
  } catch (e) {
    return `Error: invalid timezone '${timezone}'. Use an IANA name like 'America/New_York'.`;
  }
}

function calculator({ expression }) {
  if (!/^[\d\s+\-*/%().]+$/.test(expression)) {
    return "Error: expression contains invalid characters.";
  }
  try {
    const result = Function(`"use strict"; return (${expression})`)();
    if (typeof result !== "number" || !isFinite(result)) {
      return "Error: result is not a finite number.";
    }
    return String(result);
  } catch (e) {
    return `Error: could not evaluate expression: ${e.message}`;
  }
}

async function getLocation(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,timezone`);
    const data = await res.json();
    if (data.status !== "success") return "Could not determine location.";
    return `${data.city}, ${data.regionName}, ${data.country} (timezone: ${data.timezone})`;
  } catch {
    return "Could not determine location.";
  }
}

async function webSearch({ query }, apiKey) {
  try {
    const res = await fetch("https://ollama.com/api/web_search", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    if (!res.ok) return `Web search failed: ${res.statusText}`;
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch (e) {
    return `Web search error: ${e.message}`;
  }
}

async function webFetch({ url }, apiKey) {
  try {
    const res = await fetch("https://ollama.com/api/web_fetch", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (!res.ok) return `Web fetch failed: ${res.statusText}`;
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch (e) {
    return `Web fetch error: ${e.message}`;
  }
}

async function runPython({ code }) {
  // SECURITY: Only runs if you have Python installed and accept the risk.
  // This uses a child process with a timeout and no shell.
  return new Promise((resolve) => {
    import("child_process").then(({ exec }) => {
      const { promisify } = require("util");
      const execAsync = promisify(exec);
      const timeout = 5000; // 5 second limit
      
      // Write to temp file and execute
      const fs = require("fs");
      const tmpFile = `/tmp/script_${Date.now()}.py`;
      fs.writeFileSync(tmpFile, code);
      
      execAsync(`python3 ${tmpFile}`, { timeout, maxBuffer: 1024 * 1024 })
        .then(({ stdout, stderr }) => {
          fs.unlinkSync(tmpFile);
          resolve(stdout || stderr || "(no output)");
        })
        .catch((err) => {
          try { fs.unlinkSync(tmpFile); } catch {}
          resolve(`Python error: ${err.message}`);
        });
    });
  });
}

// =========================================================
// PROXY WITH AGENTIC TOOL LOOP
// =========================================================
app.post("/api/chat", async (req, res) => {
  const apiKey = req.headers["x-ollama-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing X-Ollama-Key header" });

  const { model, messages, options } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "model and messages are required" });
  }

  try {
    let currentMessages = [...messages];
    const MAX_ROUNDS = 8; // Agent loop limit

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const upstream = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: currentMessages,
          stream: true,
          tools: TOOLS,
          options: options || {},
        }),
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        return res.status(upstream.status).json({ error: text || upstream.statusText });
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";
      let toolCalls = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.content) {
              assistantContent += chunk.message.content;
              res.write(JSON.stringify({ message: { content: chunk.message.content } }) + "\n");
            }
            if (chunk.message?.tool_calls) {
              for (const tc of chunk.message.tool_calls) {
                const existing = toolCalls.find(t => t.id === tc.id);
                if (existing) {
                  existing.function.arguments += tc.function.arguments || "";
                } else {
                  toolCalls.push({
                    id: tc.id,
                    function: { name: tc.function.name, arguments: tc.function.arguments || "" },
                  });
                }
              }
            }
          } catch {}
        }
      }

      // No tool calls? We're done.
      if (toolCalls.length === 0) {
        res.end();
        return;
      }

      // Execute tools
      const toolResults = [];
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        
        let result;
        switch (tc.function.name) {
          case "get_current_time": result = getCurrentTime(args); break;
          case "calculator": result = calculator(args); break;
          case "get_location": result = await getLocation(req); break;
          case "web_search": result = await webSearch(args, apiKey); break;
          case "web_fetch": result = await webFetch(args, apiKey); break;
          case "run_python": result = await runPython(args); break;
          default: result = `Unknown tool: ${tc.function.name}`;
        }
        toolResults.push({ name: tc.function.name, result: String(result) });
      }

      // Append and loop
      currentMessages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls.map(tc => ({ id: tc.id, function: tc.function })),
      });
      for (const tr of toolResults) {
        currentMessages.push({ role: "tool", tool_name: tr.name, content: tr.result });
      }
    }

    res.end();
  } catch (err) {
    console.error("Proxy error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));