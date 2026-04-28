import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fetch from "node-fetch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "10mb" }));

// Serve frontend
app.use(express.static(join(__dirname, "dist")));

// Claude proxy
app.post("/api/claude", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.VITE_ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apify proxy
app.post("/api/apify", async (req, res) => {
  let { url, method = "GET", body } = req.body;
  if (!url) return res.status(400).json({ error: "No URL" });

  // Fix actor ID format: replace / with ~ between username and actor slug
  const actsIndex = url.indexOf("/v2/acts/");
  if (actsIndex !== -1) {
    const afterActs = url.substring(actsIndex + 9);
    const slashIndex = afterActs.indexOf("/");
    if (slashIndex !== -1) {
      const username = afterActs.substring(0, slashIndex);
      const rest = afterActs.substring(slashIndex + 1);
      const nextSlash = rest.indexOf("/");
      const actorSlug = nextSlash !== -1 ? rest.substring(0, nextSlash) : rest;
      const remainder = nextSlash !== -1 ? rest.substring(nextSlash) : "";
      url = url.substring(0, actsIndex + 9) + username + "~" + actorSlug + remainder;
    }
  }

  console.log("[Apify] " + method + " " + url);

  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    console.log("[Apify] Response status: " + response.status);
    res.json(data);
  } catch (err) {
    console.error("[Apify] Error: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Windsor AI proxy — uses server-side env var, never exposes key to browser
app.post("/api/windsor", async (req, res) => {
  const apiKey = process.env.WINDSOR_API_KEY;
  console.log("[Windsor] API key present:", !!apiKey);
  console.log("[Windsor] API key length:", apiKey ? apiKey.length : 0);
  if (!apiKey) {
    console.log("[Windsor] No API key configured — skipping");
    return res.status(400).json({ error: "Windsor not configured" });
  }
  try {
    const url = "https://connectors.windsor.ai/facebook?api_key=" + apiKey + "&date_preset=last_7d&fields=ad_name,spend,ctr,purchase_roas_omni_purchase&accounts=584820145452956";
    console.log("[Windsor] Fetching:", url.replace(apiKey, "***"));
    const response = await fetch(url, { method: "GET" });
    console.log("[Windsor] HTTP status:", response.status);
    const text = await response.text();
    console.log("[Windsor] Raw response (first 200 chars):", text.slice(0, 200));
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : (data?.data || []);
    console.log("[Windsor] Got " + rows.length + " rows, type: " + (Array.isArray(data) ? "array" : "object"));
    res.json(rows);
  } catch (err) {
    console.error("[Windsor] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// All other routes serve the frontend
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
