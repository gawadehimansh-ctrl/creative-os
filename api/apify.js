export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let { url, method = "GET", body } = req.body;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  // Fix actor ID format — replace / with ~ in apify actor URLs
  url = url.replace(
    /api\.apify\.com\/v2\/acts\/([^/]+)\/([^/?]+)/,
    (match, user, actor) => `api.apify.com/v2/acts/${user}~${actor}`
  );

  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
