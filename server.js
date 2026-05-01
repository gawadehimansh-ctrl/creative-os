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
  if (!apiKey) {
    console.log("[Windsor] No API key configured — skipping");
    return res.status(400).json({ error: "Windsor not configured" });
  }
  try {
    const url = "https://connectors.windsor.ai/all?api_key=" + apiKey + "&date_preset=last_30d&fields=account_name,ad_name,adset_name,campaign_name,spend,clicks,impressions,ctr,purchase_roas,purchases,purchase_value,purchases_conversion_value,omni_purchase_roas,website_purchase_roas,roas,video_3_sec_watched_actions,video_thruplay_watched_actions&data_source=facebook";
    console.log("[Windsor] Fetching:", url.replace(apiKey, "***"));
    const response = await fetch(url, { method: "GET" });
    console.log("[Windsor] HTTP status:", response.status);
    const text = await response.text();
    console.log("[Windsor] Raw response (first 300 chars):", text.slice(0, 300));
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : (data?.data || data?.results || []);
    console.log("[Windsor] Got " + rows.length + " rows");
    if (rows.length > 0) console.log("[Windsor] First row keys/values:", JSON.stringify(rows[0]));
    res.json(rows);
  } catch (err) {
    console.error("[Windsor] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Google Drive image proxy — fetches thumbnail as base64 to avoid CORS
app.post("/api/drive-image", async (req, res) => {
  const { driveUrl } = req.body;
  if (!driveUrl) return res.status(400).json({ error: "No URL" });
  let fileId = null;
  for (const pat of [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/, /\/d\/([a-zA-Z0-9_-]+)/]) {
    const m = String(driveUrl).match(pat);
    if (m) { fileId = m[1]; break; }
  }
  if (!fileId) return res.status(400).json({ error: "Cannot extract Drive file ID" });
  const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;
  try {
    const r = await fetch(thumbUrl, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (!r.ok) throw new Error("Drive HTTP " + r.status);
    const buf = await r.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    const mediaType = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    res.json({ base64, mediaType, fileId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claude Vision creative tagger — uses Haiku for speed/cost
app.post("/api/vision-tag", async (req, res) => {
  const { base64, mediaType, adName, product, contentType } = req.body;
  const apiKey = process.env.VITE_ANTHROPIC_KEY;
  if (!apiKey) return res.status(400).json({ error: "No Anthropic key" });
  if (!base64) return res.status(400).json({ error: "No image" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: "You are a creative analyst. Analyze the ad image and return ONLY a valid JSON object — no explanation, no markdown.",
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: `Ad: ${adName}\nProduct: ${product}\nType: ${contentType}\n\nReturn JSON with exactly these keys:\n{"format":"video|static|carousel|ugc_video|reel","person_type":"influencer|model|athlete|no_person|lifestyle|ugc_creator","text_style":"bold_headline|minimal|price_offer|no_text|testimonial|story_format","background":"studio|outdoor|home_lifestyle|plain_white|gym|product_flat_lay","hook_type":"problem_agitate|benefit_first|social_proof|urgency_offer|curiosity|transformation|tutorial","color_palette":"dark_moody|bright_vibrant|pastel_soft|monochrome|brand_colors|earth_tones","composition":"close_up|full_body|product_only|split_screen|before_after|group_shot"}` }
          ]
        }]
      })
    });
    const d = await r.json();
    const text = d?.content?.[0]?.text || "{}";
    let tags = {};
    try { tags = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch {}
    res.json({ tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All other routes serve the frontend
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
