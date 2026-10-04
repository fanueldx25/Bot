import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const OLLAMA_URL = "https://ollama.com/api/chat";

// Proxy endpoint — browser calls this, server calls Ollama Cloud
app.post("/api/chat", async (req, res) => {
  const apiKey = req.headers["x-ollama-key"];
  
  if (!apiKey) {
    return res.status(400).json({ error: "Missing X-Ollama-Key header" });
  }
  
  const { model, messages, options } = req.body || {};
  
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "model and messages are required" });
  }
  
  try {
    const upstream = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: options || {},
      }),
    });
    
    if (!upstream.ok) {
      const text = await upstream.text();
      return res
        .status(upstream.status)
        .json({ error: text || upstream.statusText });
    }
    
    // Stream NDJSON straight through to the browser
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    console.error("Proxy error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Proxy failed" });
    } else {
      res.end();
    }
  }
});

// List available cloud models
app.get("/api/tags", async (req, res) => {
  const apiKey = req.headers["x-ollama-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing X-Ollama-Key" });
  
  try {
    const upstream = await fetch("https://ollama.com/api/tags", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});