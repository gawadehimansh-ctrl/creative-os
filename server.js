import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fetch from "node-fetch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "10mb" }));

// Serve frontend
app.use(express.static(join(__dirname, "dist")));

// Claude proxy — retries on 429 with exponential backoff
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_KEY;
  const backoffs = [2000, 5000, 12000];
  let lastErr;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(req.body),
      });
      if (response.status === 429 && attempt < 3) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "0") * 1000;
        await new Promise(r => setTimeout(r, retryAfter || backoffs[attempt]));
        continue;
      }
      return res.json(await response.json());
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, backoffs[attempt]));
    }
  }
  res.status(500).json({ error: lastErr?.message || "Claude API failed after retries" });
});

// Apify proxy — injects token server-side so it never reaches the browser
app.post("/api/apify", async (req, res) => {
  let { url, method = "GET", body } = req.body;
  if (!url) return res.status(400).json({ error: "No URL" });

  const apifyToken = process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN;
  if (apifyToken) url += (url.includes("?") ? "&" : "?") + "token=" + apifyToken;

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

// AssemblyAI proxy
app.post("/api/assemblyai", async (req, res) => {
  const { path, method = "GET", body } = req.body;
  const apiKey = process.env.ASSEMBLYAI_KEY || process.env.VITE_ASSEMBLYAI_KEY;
  if (!apiKey) return res.status(400).json({ error: "No AssemblyAI key" });
  if (!path) return res.status(400).json({ error: "No path" });
  try {
    const r = await fetch("https://api.assemblyai.com" + path, {
      method,
      headers: { "Authorization": apiKey, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shotstack proxy
app.post("/api/shotstack", async (req, res) => {
  const { path, method = "POST", body } = req.body;
  const apiKey = process.env.SHOTSTACK_KEY || process.env.VITE_SHOTSTACK_KEY;
  if (!apiKey) return res.status(400).json({ error: "No Shotstack key" });
  if (!path) return res.status(400).json({ error: "No path" });
  try {
    const r = await fetch("https://api.shotstack.io" + path, {
      method,
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    res.json(await r.json());
  } catch (err) {
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

// Helper: extract a Google Drive file ID from a URL, or null if not a Drive URL
function extractDriveFileId(url) {
  for (const pat of [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/, /\/d\/([a-zA-Z0-9_-]+)/]) {
    const m = String(url).match(pat);
    if (m) return m[1];
  }
  return null;
}

// Helper: fetch any image URL (Drive or direct) and return { base64, mediaType, fileId, thumbUrl }
async function fetchImageAsBase64(imageUrl) {
  const fileId = extractDriveFileId(imageUrl);
  const target = fileId ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w800` : imageUrl;
  const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!r.ok) throw new Error("Image fetch HTTP " + r.status);
  const buf = await r.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  const mediaType = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  const thumbUrl = fileId ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w400` : imageUrl;
  return { base64, mediaType, fileId, thumbUrl };
}

// Vision analysis — accepts array of { adName, imageUrl }, returns 7 visual tags per image
app.post("/api/vision-analyze", async (req, res) => {
  const { images } = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_KEY;
  if (!apiKey) return res.status(400).json({ error: "No Anthropic key" });
  if (!Array.isArray(images) || images.length === 0) return res.status(400).json({ error: "No images" });

  const results = [];
  for (const img of images) {
    const { adName, imageUrl } = img || {};
    if (!imageUrl) continue;
    try {
      const { base64, mediaType, fileId, thumbUrl } = await fetchImageAsBase64(imageUrl);
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
              { type: "text", text: `Ad: ${adName || "(unnamed)"}\n\nReturn JSON with exactly these keys:\n{"format":"video|static|carousel|ugc_video|reel","person_type":"influencer|model|athlete|no_person|lifestyle|ugc_creator","text_style":"bold_headline|minimal|price_offer|no_text|testimonial|story_format","background":"studio|outdoor|home_lifestyle|plain_white|gym|product_flat_lay","hook_type":"problem_agitate|benefit_first|social_proof|urgency_offer|curiosity|transformation|tutorial","color_palette":"dark_moody|bright_vibrant|pastel_soft|monochrome|brand_colors|earth_tones","composition":"close_up|full_body|product_only|split_screen|before_after|group_shot"}` }
            ]
          }]
        })
      });
      const d = await r.json();
      const text = d?.content?.[0]?.text || "{}";
      let tags = {};
      try { tags = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch {}
      results.push({ adName, imageUrl, visualTags: tags, thumbUrl, fileId });
    } catch (e) {
      console.error("[vision-analyze] failed for", adName, e.message);
    }
  }
  res.json({ results });
});

// Blissclub dashboard connector — pulls top Meta ads by ROAS
app.post("/api/blissclub-data", async (req, res) => {
  const proxyUrl = process.env.BLISSCLUB_PROXY_URL || "https://blissclub-proxy-production.up.railway.app";
  const apiKey = process.env.BLISSCLUB_API_KEY;
  const { datePreset = "last_30dT" } = req.body || {};
  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    const r = await fetch(`${proxyUrl}/api/meta/daily?date_preset=${datePreset}`, { headers, redirect: "follow" });
    if (!r.ok) throw new Error("Blissclub proxy HTTP " + r.status);
    const raw = await r.json();
    const rows = (Array.isArray(raw) ? raw : raw?.data || [])
      .sort((a, b) => (b.action_values_purchase || 0) - (a.action_values_purchase || 0))
      .slice(0, 20);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Creative generation — GPT-4o writes a precise prompt → DALL-E 3 generates ad image
app.post("/api/generate-creative", async (req, res) => {
  const { icp, visualPattern, brand, product, usp } = req.body || {};
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: "No OpenAI key configured" });

  try {
    const p = icp?.profile || {};
    const pr = icp?.problem || {};
    const cr = icp?.creative || {};
    const hook = cr?.hooks?.[0]?.hook || "";

    // Step 1: GPT-4o writes the DALL-E 3 prompt
    const promptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + openaiKey },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 500,
        messages: [
          { role: "system", content: "You are a performance creative director for Indian D2C brands. Write precise DALL-E 3 image generation prompts for high-converting Meta/Instagram ad creatives. Return ONLY the image prompt, nothing else." },
          { role: "user", content: `Write a DALL-E 3 prompt for a ${brand} ad targeting this ICP:

ICP: ${p.name || "Indian woman"}, ${p.age_range || "25-35"}, ${p.city_tier || "Tier 1"}, ${p.income_bracket || "mid-premium"}
Core problem: "${pr.core_problem || ""}"
Emotion before purchase: ${pr.emotion_before_purchase || ""}
Winning visual pattern from top ROAS ads: format=${visualPattern?.format || "static"}, hook=${visualPattern?.hook_type || "benefit_first"}, composition=${visualPattern?.composition || "close_up"}, colors=${visualPattern?.color_palette || "bright_vibrant"}, background=${visualPattern?.background || "studio"}, person=${visualPattern?.person_type || "lifestyle"}
Product: ${product}
Key USP: ${usp || ""}
Ad hook: "${hook}"

Rules: photorealistic Indian lifestyle photography, high-production quality, no text in image, authentic to the ICP's world (${p.city_tier || "metro India"}). Max 300 words.` }
        ]
      })
    });
    const promptData = await promptRes.json();
    if (promptData.error) throw new Error("GPT-4o: " + promptData.error.message);
    const dallePrompt = promptData.choices?.[0]?.message?.content?.trim() || "";

    // Step 2: DALL-E 3 generates the image
    const imageRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + openaiKey },
      body: JSON.stringify({ model: "gpt-image-2", prompt: dallePrompt, n: 1, size: "1024x1024", quality: "standard" })
    });
    const imageData = await imageRes.json();
    if (imageData.error) throw new Error("DALL-E 3: " + imageData.error.message);
    res.json({ imageUrl: imageData.data?.[0]?.url, dallePrompt, revisedPrompt: imageData.data?.[0]?.revised_prompt });
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
