import { useState, useEffect, useRef } from "react";

const CONFIG = {};

const LIMITS = { amazon:30, flipkart:25, myntra:20, youtube:25, tiktok:20, instagram:20, reddit:20, quora:15 };

const PIPELINE_STEPS = [
  { key:"read_urls",      label:"Reading brand & product URLs + extracting USPs" },
  { key:"extract",        label:"Extracting problem keywords" },
  { key:"windsor",        label:"Fetching Meta ad performance data (Blissclub → Windsor fallback)" },
  { key:"meta_ads",       label:"Scraping Meta Ads Library (competitor creatives)" },
  { key:"amazon",         label:"Scraping Amazon India (multi-brand reviews)" },
  { key:"flipkart",       label:"Scraping Flipkart (auto keyword search)" },
  { key:"myntra",         label:"Scraping Myntra reviews" },
  { key:"reddit",         label:"Scraping Reddit discussions (auto)" },
  { key:"youtube",        label:"Scraping YouTube comments" },
  { key:"tiktok",         label:"Scraping TikTok trends (auto)" },
  { key:"instagram",      label:"Scraping Instagram comments" },
  { key:"quora",          label:"Scraping Quora discussions (auto)" },
  { key:"video_analysis",  label:"Analysing winning ad videos" },
  { key:"creative_intel",  label:"Creative sheet × Windsor join — Vision AI tagging top 3" },
  { key:"research",        label:"Building Research Intelligence — pain clusters & whitespace" },
  { key:"brief",           label:"Generating deep ICP briefs" },
];

const defaultProgress = Object.fromEntries(PIPELINE_STEPS.map(s => [s.key,"pending"]));

const T = {
  accent:"#c84b2f", ink:"#f5f0e8", bg:"#0c0c0b",
  muted:"rgba(245,240,232,0.4)", rule:"rgba(245,240,232,0.08)",
  card:"rgba(255,255,255,0.04)", cardBorder:"rgba(255,255,255,0.08)",
  green:"#4caf50", red:"rgba(255,100,80,0.8)", warn:"rgba(255,180,50,0.85)",
  blue:"rgba(100,160,255,0.85)",
};

const LS_KEY = "briefengine_v6_brands";
function loadBrands() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } }
function saveBrand(name, ctx) { const all = loadBrands(); all[name] = {...ctx, updatedAt:Date.now()}; localStorage.setItem(LS_KEY, JSON.stringify(all)); }
function getSavedBrand(name) { return loadBrands()[name] || null; }

const BRIEF_CACHE_KEY = "briefengine_v6_last_brief";
function saveLastBrief(payload) { try { localStorage.setItem(BRIEF_CACHE_KEY, JSON.stringify(payload)); } catch {} }
function loadLastBrief() { try { return JSON.parse(localStorage.getItem(BRIEF_CACHE_KEY)); } catch { return null; } }
function clearLastBrief() { try { localStorage.removeItem(BRIEF_CACHE_KEY); } catch {} }

function validateUrls(data) {
  const errors = [];
  if (data.amazonUrls.filter(u=>u.trim()).length < 3) errors.push("Amazon URLs — add at least 3 (your brand + competitors)");
  if (!data.myntraUrl.trim()) errors.push("Myntra — add the product URL");
  if (data.youtubeUrls.filter(u=>u.trim()).length < 2) errors.push("YouTube — add at least 2 review/haul video URLs");
  if (data.instagramUrls.filter(u=>u.trim()).length < 2) errors.push("Instagram — add at least 2 URLs (brand + competitor)");
  return errors;
}

// ─── CLAUDE ──────────────────────────────────────────────────

async function claudeCall(system, userContent, maxTokens=2000) {
  try {
    const res = await fetch("/api/claude", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:maxTokens,system,messages:[{role:"user",content:userContent}]}),
    });
    const data = JSON.parse(await res.text());
    return data.content?.find(b=>b.type==="text")?.text || "";
  } catch(e) { console.error("claudeCall failed:",e); return ""; }
}

async function claudeVisionCall(system, textContent, imageUrls, maxTokens=2000) {
  const content = [];
  if (textContent) content.push({type:"text",text:textContent});
  for (const url of imageUrls.slice(0,6)) {
    try {
      const blob = await (await fetch(url)).blob();
      const base64 = await new Promise(r => { const reader = new FileReader(); reader.onloadend = () => r(reader.result.split(",")[1]); reader.readAsDataURL(blob); });
      content.push({type:"image",source:{type:"base64",media_type:"image/jpeg",data:base64}});
    } catch(e) { console.error("Frame load failed:",e); }
  }
  const res = await fetch("/api/claude", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:maxTokens,system,messages:[{role:"user",content}]}),
  });
  const data = await res.json();
  return data.content?.find(b=>b.type==="text")?.text || "";
}

function parseJSON(raw) {
  try { return JSON.parse(raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim()); }
  catch { try { const m = raw.match(/\{[\s\S]*\}/); if(m) return JSON.parse(m[0]); } catch {} return null; }
}


// ─── WINDSOR AI ───────────────────────────────────────────────

async function fetchWindsorData() {
  try {
    const res = await fetch("/api/windsor", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    return null;
  } catch(e) { console.error("Windsor fetch failed:",e); return null; }
}

async function fetchBlissclubData() {
  try {
    const res = await fetch("/api/blissclub-data", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ datePreset: "last_30dT" }),
    });
    const data = await res.json();
    if (data.error || !Array.isArray(data.rows) || !data.rows.length) return null;
    // Normalise to Windsor-compatible field names so all downstream joins work unchanged
    return data.rows.map(r => ({
      ...r,
      ad_name:        r.ad_name,
      spend:          r.spend || 0,
      purchase_value: r.action_values_purchase || 0,
      purchases:      r.actions_purchase || 0,
      purchase_roas:  r.spend > 0 && r.action_values_purchase > 0
                        ? r.action_values_purchase / r.spend : 0,
    }));
  } catch(e) { console.error("Blissclub fetch failed:",e); return null; }
}

function parseCreativeName(name) {
  if (!name) return { cohort:"ACQ", format:"Static", product:"Other", contentType:"Tactical", creator:null };
  const n = String(name);
  const cohortMatch = n.match(/^(ACQ|RET|REM|ALWAYS_ON)/i);
  const cohort = cohortMatch ? cohortMatch[1].toUpperCase() : "ACQ";
  const afterDash = n.split("-")[1] || "";
  const fmtMatch = afterDash.match(/^(video|static|carousel|reel|ugc|dpa)/i);
  const fmt = fmtMatch ? fmtMatch[1] : null;
  const format = fmt ? fmt.charAt(0).toUpperCase()+fmt.slice(1).toLowerCase()
    : n.toLowerCase().includes("video") ? "Video"
    : n.toLowerCase().includes("static") ? "Static"
    : n.toLowerCase().includes("carousel") ? "Carousel" : "Static";
  const products = ["LTC_Flare","LTC_USP","LTC_AMPM","LTC_Wide","BB_Str","BB_Fit","LTC_LiteFlare","TravelCollectionMP","LTC_Shorts","LTC_Tee","CloudSoft","Unstoppable","MoveEase","FlexShorts"];
  let product = "Other";
  for (const p of products) { if (n.includes(p)) { product = p; break; } }
  const ctMap = { INF:"Influencer", CCP:"CCP", Tactical:"Tactical", WYLD:"WYLD", UGC:"UGC" };
  let contentType = "Tactical";
  for (const [k,v] of Object.entries(ctMap)) { if (n.includes("_"+k+"_")) { contentType = v; break; } }
  const creatorMatch = n.match(/(?:INF|CCP)_([A-Za-z]+)_/);
  const creator = creatorMatch ? creatorMatch[1] : null;
  return { cohort, format, product, contentType, creator };
}

function parseCreativeAngles(rows) {
  if (!rows?.length) return null;
  const getRoas = r => {
    const direct = r.website_purchase_roas || r.purchase_roas || r.omni_purchase_roas || r.purchase_roas_omni_purchase || r.roas || 0;
    if (direct > 0) return direct;
    const val = r.purchase_value || r.purchases_conversion_value || 0;
    if (val > 0 && r.spend > 0) return val / r.spend;
    return 0;
  };
  const withRoas = rows.filter(r => getRoas(r) > 0 && (r.spend||0) > 0);
  const sorted = [...withRoas].sort((a,b) => getRoas(b)-getRoas(a));

  const topPerformers = sorted.slice(0,8).map(r => {
    const parsed = parseCreativeName(r.ad_name);
    const hook = r.impressions > 0 ? (r.video_3_sec_watched_actions||0)/r.impressions : 0;
    const hold = r.video_3_sec_watched_actions > 0 ? (r.video_thruplay_watched_actions||0)/r.video_3_sec_watched_actions : 0;
    return {
      ad_name: r.ad_name||"",
      creative_name: r.ad_name||"",
      spend: Math.round(r.spend||0),
      roas: Number(getRoas(r).toFixed(2)),
      ctr: Number((r.ctr||0).toFixed(2)),
      purchases: Math.round(r.purchases||0),
      format: parsed.format,
      product: parsed.product,
      contentType: parsed.contentType,
      creator: parsed.creator,
      cohort: parsed.cohort,
      hook_rate: hook > 0 ? Number((hook*100).toFixed(1)) : null,
      hold_rate: hold > 0 ? Number((hold*100).toFixed(1)) : null,
    };
  });

  const fatigued = withRoas
    .filter(r => r.spend>5000 && getRoas(r)<1.5)
    .sort((a,b) => b.spend-a.spend).slice(0,5)
    .map(r => {
      const parsed = parseCreativeName(r.ad_name);
      return { ad_name:r.ad_name||"", creative_name:r.ad_name||"", spend:Math.round(r.spend||0), roas:Number(getRoas(r).toFixed(2)), format:parsed.format, product:parsed.product, contentType:parsed.contentType };
    });

  const avgRoas = arr => arr.length ? Number((arr.reduce((s,r)=>s+getRoas(r),0)/arr.length).toFixed(2)) : 0;

  // Format breakdown
  const byFormat = {};
  for (const r of withRoas) {
    const k = parseCreativeName(r.ad_name).format;
    if (!byFormat[k]) byFormat[k] = [];
    byFormat[k].push(r);
  }
  const format_performance = Object.fromEntries(Object.entries(byFormat).map(([k,arr])=>
    [k.toLowerCase(), { count:arr.length, avg_roas:avgRoas(arr), total_spend:Math.round(arr.reduce((s,r)=>s+(r.spend||0),0)) }]
  ));

  // Product breakdown
  const byProduct = {};
  for (const r of withRoas) {
    const k = parseCreativeName(r.ad_name).product;
    if (!byProduct[k]) byProduct[k] = [];
    byProduct[k].push(r);
  }
  const product_performance = Object.entries(byProduct)
    .map(([prod,arr]) => ({ product:prod, count:arr.length, avg_roas:avgRoas(arr), total_spend:Math.round(arr.reduce((s,r)=>s+(r.spend||0),0)) }))
    .sort((a,b) => b.total_spend-a.total_spend);

  // Content type breakdown
  const byContentType = {};
  for (const r of withRoas) {
    const k = parseCreativeName(r.ad_name).contentType;
    if (!byContentType[k]) byContentType[k] = [];
    byContentType[k].push(r);
  }
  const content_type_performance = Object.entries(byContentType)
    .map(([ct,arr]) => ({ type:ct, count:arr.length, avg_roas:avgRoas(arr), total_spend:Math.round(arr.reduce((s,r)=>s+(r.spend||0),0)) }))
    .sort((a,b) => b.avg_roas-a.avg_roas);

  return {
    top_performers: topPerformers,
    fatigued_angles: fatigued,
    total_ads_analysed: withRoas.length,
    total_spend_analysed: Math.round(withRoas.reduce((s,r)=>s+(r.spend||0),0)),
    format_performance,
    product_performance,
    content_type_performance,
    best_roas: Number(getRoas(sorted[0]||{}).toFixed(2))||0,
    best_creative: sorted[0]?.ad_name||"",
  };
}

// ─── CREATIVE SHEET INTELLIGENCE ─────────────────────────────

async function parseCreativeSheet(file) {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rows.map(r => ({
    adName:       String(r["AD Name"]      || r["Ad Name"]      || r["AD NAME"]      || "").trim(),
    product:      String(r["Product"]      || "").trim(),
    format:       String(r["Format"]       || "").trim(),
    productTag:   String(r["Product Tag"]  || "").trim(),
    contentType:  String(r["Content Type"] || "").trim(),
    theme:        String(r["Theme"]        || "").trim(),
    date:         String(r["Date"]         || "").trim(),
    creativeLink: String(r["Creative Link"]|| "").trim(),
    lpLink:       String(r["LP Link"]      || "").trim(),
    primaryText:  String(r["Primary Text"] || "").trim(),
    headlines:    String(r["Headlines"]    || "").trim(),
  })).filter(r => r.adName);
}

function joinSheetWithWindsor(sheetRows, windsorRows) {
  const sheetMap = new Map();
  for (const r of sheetRows) sheetMap.set(r.adName.toLowerCase(), r);
  const getRoas = r => r.website_purchase_roas || r.purchase_roas || r.omni_purchase_roas || r.roas
    || (r.purchase_value > 0 && r.spend > 0 ? r.purchase_value / r.spend : 0) || 0;
  return windsorRows
    .map(w => {
      const sheet = sheetMap.get((w.ad_name||"").toLowerCase());
      if (!sheet) return null;
      return {
        adName:      w.ad_name,
        roas:        getRoas(w),
        spend:       w.spend || 0,
        purchases:   w.purchases || 0,
        ctr:         w.ctr || 0,
        impressions: w.impressions || 0,
        product:     sheet.product,
        format:      sheet.format,
        contentType: sheet.contentType,
        theme:       sheet.theme,
        creativeLink:sheet.creativeLink,
        primaryText: sheet.primaryText,
        headlines:   sheet.headlines,
        productTag:  sheet.productTag,
      };
    })
    .filter(r => r && r.roas > 0 && r.spend > 0)
    .sort((a, b) => b.roas - a.roas);
}

async function analyzeCreativesWithVision(topRows) {
  const candidates = topRows.slice(0, 3).filter(r => r.creativeLink);
  if (!candidates.length) return [];
  try {
    const res = await fetch("/api/vision-analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: candidates.map(r => ({ adName: r.adName, imageUrl: r.creativeLink })),
      }),
    });
    if (!res.ok) return [];
    const { results } = await res.json();
    const byAdName = new Map((results || []).map(r => [r.adName, r]));
    return candidates
      .map(row => {
        const tagged = byAdName.get(row.adName);
        if (!tagged) return null;
        return { ...row, visualTags: tagged.visualTags || {}, thumbUrl: tagged.thumbUrl };
      })
      .filter(Boolean);
  } catch (e) {
    console.error("[Vision] failed:", e.message);
    return [];
  }
}

function computeVisualCorrelations(analysedRows, allJoinedRows) {
  if (!analysedRows?.length) return null;
  const avgRoasAll = allJoinedRows.length
    ? allJoinedRows.reduce((s,r) => s+r.roas, 0) / allJoinedRows.length : 0;
  const dims = ["format","person_type","text_style","background","hook_type","color_palette","composition"];
  const correlations = {};
  for (const dim of dims) {
    const byTag = {};
    for (const row of analysedRows) {
      const tag = row.visualTags?.[dim]; if (!tag) continue;
      if (!byTag[tag]) byTag[tag] = { roas:[], spend:0, count:0 };
      byTag[tag].roas.push(row.roas); byTag[tag].spend += row.spend; byTag[tag].count++;
    }
    correlations[dim] = Object.entries(byTag).map(([tag,d]) => {
      const avg = d.roas.reduce((s,v)=>s+v,0)/d.roas.length;
      return { tag, avg_roas: Number(avg.toFixed(2)), count: d.count,
        total_spend: Math.round(d.spend),
        lift: avgRoasAll > 0 ? Number(((avg/avgRoasAll-1)*100).toFixed(0)) : 0 };
    }).sort((a,b) => b.avg_roas - a.avg_roas);
  }
  return { correlations, top_creatives: analysedRows, total_analysed: analysedRows.length, avg_roas_all: Number(avgRoasAll.toFixed(2)) };
}

// ─── READ URLs + EXTRACT USPs ─────────────────────────────────

async function readUrlsWithClaude(brandUrl, productUrl, extraUrls, mediaKeywords) {
  const system = `You are a senior D2C brand strategist. Return pure JSON only — no markdown, no backticks:
{
  "brand_name":string,
  "brand_tagline":string,
  "brand_tone":string,
  "product_name":string,
  "product_description":string,
  "product_category":string,
  "price_point":string,
  "target_audience":string,
  "core_problem_solved":string,
  "extracted_usps":[6-10 strings — exact product USPs/features extracted from the URLs. Be specific.],
  "problem_keywords":[8-12 strings — problem-level consumer language, NOT brand names],
  "flipkart_search_terms":[2-3 strings],
  "reddit_search_terms":[3-4 strings — problem-level],
  "reddit_subreddits":[4-6 strings — WITHOUT r/ prefix],
  "quora_search_terms":[3-4 strings — question-style],
  "tiktok_hashtags":[6-8 strings — WITHOUT #, category-level],
  "instagram_hashtags":[6-8 strings — WITHOUT #],
  "extra_context":string
}`;
  const userMsg = `Brand URL: ${brandUrl}
Product URL: ${productUrl}
Extra URLs: ${extraUrls.length>0?extraUrls.join(", "):"None"}
Media Buyer Keywords: ${mediaKeywords||"Not provided"}

Analyse these URLs deeply. Extract specific, concrete USPs.`;
  const raw = await claudeCall(system, userMsg, 2500);
  return parseJSON(raw) || {};
}

// ─── APIFY ───────────────────────────────────────────────────

async function apifyProxy(url, method="GET", body=null) {
  const res = await fetch("/api/apify", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({url,method,body}),
  });
  return await res.json();
}

async function runApifyActor(actorId, input) {
  const startJson = await apifyProxy("https://api.apify.com/v2/acts/"+actorId+"/runs","POST",input);
  const runId = startJson?.data?.id;
  if (!runId) throw new Error("Actor start failed: "+actorId);
  let status="RUNNING", attempts=0;
  while(["RUNNING","READY","ABORTING"].includes(status) && attempts<60) {
    await new Promise(r=>setTimeout(r,4000));
    const poll = await apifyProxy("https://api.apify.com/v2/actor-runs/"+runId);
    status=poll?.data?.status; attempts++;
  }
  const runInfo = await apifyProxy("https://api.apify.com/v2/actor-runs/"+runId);
  const datasetId = runInfo?.data?.defaultDatasetId;
  return await apifyProxy("https://api.apify.com/v2/datasets/"+datasetId+"/items?limit=150");
}

// ─── SCRAPERS ────────────────────────────────────────────────

async function scrapeAmazon(amazonUrls) {
  try {
    const filled = amazonUrls.filter(Boolean);
    if (!filled.length) return "";
    const items = await runApifyActor("web_wanderer/amazon-reviews-extractor",{products:filled,all_stars:true,personal_data:false,include_variants:false,scrape_image_reviews:false,scrape_video_reviews:false});
    return items.map(r=>[r.reviewTitle,r.reviewText].filter(Boolean).join(" — ")).filter(t=>t.length>10).slice(0,LIMITS.amazon).join("\n---\n");
  } catch(e) { console.error("Amazon failed:",e); return ""; }
}

async function scrapeFlipkart(terms) {
  try {
    if (!terms?.length) return "";
    const items = await runApifyActor("shahidirfan/flipkart-reviews-scraper",{startUrls:[{url:"https://www.flipkart.com/search?q="+encodeURIComponent(terms[0])}]});
    return items.map(r=>[r.title,r.review_text].filter(Boolean).join(" — ")).filter(t=>t.length>10).slice(0,LIMITS.flipkart).join("\n---\n");
  } catch(e) { console.error("Flipkart failed:",e); return ""; }
}

async function scrapeMyntra(url) {
  if (!url) return "";
  try {
    const items = await runApifyActor("krazee_kaushik/myntra-product-reviews-extractor",{productUrls:[url],reviewsLimit:LIMITS.myntra});
    return items.map(r=>r.review).filter(t=>t&&t.length>10).slice(0,LIMITS.myntra).join("\n---\n");
  } catch(e) { console.error("Myntra failed:",e); return ""; }
}

async function scrapeReddit(terms, subs) {
  try {
    if (!terms?.length) return "";
    const subreddits = subs?.length>0 ? subs : ["femalefashionadvice","indianfashion","indiaonreddit","TwoXIndia","indiashopping"];
    const results = [];
    for (const sub of subreddits.slice(0,3)) {
      try {
        const searchUrl = "https://www.reddit.com/r/"+sub+"/search/?q="+encodeURIComponent(terms[0])+"&sort=relevance&t=year";
        const items = await runApifyActor("trudax/reddit-scraper-lite",{startUrls:[{url:searchUrl}],maxItems:LIMITS.reddit,maxComments:10,searchPosts:true,searchComments:false,skipComments:false,sort:"relevance",includeNSFW:false});
        results.push(...items.map(r=>[r.title,r.body].filter(Boolean).join(" — ")).filter(t=>t.length>10));
      } catch(e) { console.error("Reddit sub failed:",sub,e); }
    }
    return results.slice(0,LIMITS.reddit).join("\n---\n");
  } catch(e) { console.error("Reddit failed:",e); return ""; }
}

async function scrapeYouTube(urls) {
  if (!urls?.length) return "";
  try {
    let all = "";
    for (const url of urls.filter(Boolean).slice(0,4)) {
      const items = await runApifyActor("streamers/youtube-comments-scraper",{directUrls:[url],maxComments:LIMITS.youtube,sortOrder:"Top comments"});
      all += items.map(r=>r.text||r.comment||r.content).filter(t=>t&&t.length>5).join("\n---\n")+"\n---\n";
    }
    return all;
  } catch(e) { console.error("YouTube failed:",e); return ""; }
}

async function scrapeTikTok(hashtags) {
  if (!hashtags?.length) return "";
  try {
    const items = await runApifyActor("clockworks/tiktok-scraper",{hashtags:hashtags.slice(0,6),resultsPerPage:LIMITS.tiktok,commentsPerPost:25,shouldDownloadVideos:false,shouldDownloadCovers:false,shouldDownloadAvatars:false,shouldDownloadMusicCovers:false,shouldDownloadSlideshowImages:false,excludePinnedPosts:false,scrapeRelatedVideos:false});
    return items.flatMap(item=>{
      const p=[];
      if(item.text||item.description) p.push(item.text||item.description);
      if(item.comments) p.push(...item.comments.map(c=>c.text).filter(Boolean));
      return p;
    }).filter(t=>t&&t.length>5).slice(0,60).join("\n---\n");
  } catch(e) { console.error("TikTok failed:",e); return ""; }
}

async function scrapeInstagram(urls, hashtags) {
  try {
    const all = [...(urls||[]).filter(Boolean)];
    if (hashtags?.length) hashtags.slice(0,3).forEach(tag=>all.push("https://www.instagram.com/explore/tags/"+tag+"/"));
    if (!all.length) return "";
    const items = await runApifyActor("apify/instagram-scraper",{directUrls:all,resultsType:"comments",resultsLimit:LIMITS.instagram,searchType:"hashtag",searchLimit:1,addParentData:false});
    return items.map(r=>r.text||r.comment||"").filter(t=>t.length>5).slice(0,LIMITS.instagram).join("\n---\n");
  } catch(e) { console.error("Instagram failed:",e); return ""; }
}

async function scrapeQuora(terms) {
  try {
    if (!terms?.length) return "";
    const results = [];
    for (const term of terms.slice(0,2)) {
      try {
        const searchUrl = "https://www.quora.com/search?q="+encodeURIComponent(term);
        const items = await runApifyActor("apify/web-scraper",{startUrls:[{url:searchUrl}],maxCrawlingDepth:1,maxPagesPerCrawl:5});
        results.push(...items.map(r=>r.text||r.content||"").filter(t=>t.length>20).slice(0,10));
      } catch(e) {
        console.error("Quora scrape failed:",e);
      }
    }
    return results.slice(0,LIMITS.quora).join("\n---\n");
  } catch(e) { console.error("Quora failed:",e); return ""; }
}

// ─── META ADS LIBRARY ─────────────────────────────────────────

async function scrapeMetaAdsLibrary(brandName, competitorNames) {
  try {
    const searchTerms = [brandName, ...(competitorNames||[])].filter(Boolean).slice(0,4);
    const allAds = [];

    for (const term of searchTerms) {
      try {
        const items = await runApifyActor("curious_coder/facebook-ads-library-scraper", {
          searchTerms: [term],
          adType: "all",
          adsCount: 30,
          countryCode: "IN",
          activeStatus: "active",
        });
        const parsed = (Array.isArray(items) ? items : []).map(ad => ({
          brand: term,
          id: ad.id || ad.adArchiveID || "",
          headline: ad.snapshot?.title || ad.title || "",
          body: ad.snapshot?.body?.markup?.__html || ad.snapshot?.body || ad.body || "",
          cta: ad.snapshot?.cta_text || ad.cta || "",
          format: ad.snapshot?.videos?.length > 0 ? "video" : "static",
          start_date: ad.startDate || ad.start_date || "",
          platforms: ad.publisherPlatforms || [],
          impressions: ad.impressionsWithIndex?.impressionsText || "",
          spend: ad.spend || "",
        })).filter(a => a.headline || a.body);
        allAds.push(...parsed);
      } catch(e) { console.error("Meta Ads failed for:", term, e); }
    }

    return allAds;
  } catch(e) { console.error("Meta Ads Library failed:", e); return []; }
}

function parseMetaAdsInsights(ads) {
  if (!ads?.length) return null;

  const byBrand = {};
  ads.forEach(ad => {
    if (!byBrand[ad.brand]) byBrand[ad.brand] = [];
    byBrand[ad.brand].push(ad);
  });

  const videoCount = ads.filter(a => a.format === "video").length;
  const staticCount = ads.filter(a => a.format === "static").length;

  const hooks = ads
    .map(a => a.headline || a.body?.slice(0,100))
    .filter(Boolean)
    .slice(0, 20);

  const ctaTypes = {};
  ads.forEach(a => {
    if (a.cta) ctaTypes[a.cta] = (ctaTypes[a.cta] || 0) + 1;
  });

  return {
    total_ads: ads.length,
    brands_analysed: Object.keys(byBrand),
    format_split: { video: videoCount, static: staticCount },
    active_hooks: hooks,
    top_ctas: Object.entries(ctaTypes).sort((a,b) => b[1]-a[1]).slice(0,5).map(([cta,count]) => ({cta,count})),
    by_brand: byBrand,
    raw: ads.slice(0, 50),
  };
}



async function generateResearchIntelligence(inputs) {
  const { amazonUrls, allScrapedData, urlIntelligence } = inputs;

  // Auto-extract competitor brand names from Amazon URLs
  const competitorNames = [];
  for (const url of (amazonUrls||[]).filter(Boolean)) {
    // Extract brand from URL slug: /BrandName-Product-Description/dp/
    const match = url.match(/amazon\.in\/([^/]+)\//);
    if (match) {
      const slug = match[1].replace(/-/g," ").split(" ").slice(0,2).join(" ");
      if (slug && !competitorNames.includes(slug)) competitorNames.push(slug);
    }
  }

  const system = `You are a consumer intelligence analyst for D2C performance marketing. 
Return ONLY valid JSON, no markdown, no backticks.

Analyse ALL the scraped review data and produce:
{
  "data_summary": {
    "total_signals": number,
    "platform_counts": { "amazon": number, "flipkart": number, "myntra": number, "reddit": number, "youtube": number, "tiktok": number, "instagram": number, "quora": number },
    "key_finding": string — one sentence, the single most important insight from all the data
  },
  "pain_themes": [
    {
      "theme": string — short name e.g. "No pockets",
      "full_description": string — what the actual problem is in consumer language,
      "mention_count": number — estimated mentions across all data,
      "platforms": [strings — which platforms mentioned this],
      "platform_count": number,
      "severity": "high" | "medium" | "low",
      "verbatim_quotes": [2-3 strings — exact phrases from the data, or close paraphrases],
      "competitor_coverage": {
        COMPETITOR_NAME: "addressed" | "partial" | "none"
        — for each competitor, does their review data show customers saying this problem is SOLVED?
      },
      "whitespace_score": number 0-10 — 10 means zero competitors solving this,
      "whitespace_angle": {
        "hook": string — verbatim hook using exact consumer language,
        "static_headline": string — ready to paste into Meta Ads,
        "creator_direction": string — one sentence direction for UGC creator,
        "why_this_works": string — the insight behind the angle
      }
    }
  ],
  "tiktok_hashtags": [
    { "hashtag": string, "estimated_reach": string, "relevance": string }
  ],
  "top_comments": [
    {
      "text": string,
      "platform": string,
      "sentiment": "positive" | "negative" | "neutral",
      "pain_theme": string — which theme this relates to,
      "frequency_signal": number 1-10 — how representative this sentiment is
    }
  ],
  "global_whitespace": string — the single biggest unaddressed angle across ALL competitors
}`;

  const dataBlock = Object.entries(allScrapedData)
    .filter(([,v])=>v && v.length > 10)
    .map(([k,v])=>`${k.toUpperCase()} DATA:\n${v.slice(0,600)}`)
    .join("\n\n");

  const userMsg = `BRAND: ${urlIntelligence.brand_name}
PRODUCT: ${urlIntelligence.product_name}
COMPETITORS DETECTED FROM URLs: ${competitorNames.join(", ") || "Unknown — infer from review data"}
PRODUCT USPs: ${(urlIntelligence.extracted_usps||[]).join("; ")}

ALL SCRAPED DATA:
${dataBlock}

INSTRUCTIONS:
1. Identify 5-8 distinct pain themes from the data. Each must be genuinely different.
2. For competitor_coverage — look at whether THEIR customers in THEIR reviews say the problem is solved. If you can't tell, mark "none".
3. Whitespace score 10 = nobody solving it = your best angle. Score 0 = everyone solving it = avoid.
4. Verbatim quotes must come from the actual data — use real phrases you see in the reviews.
5. The hook in whitespace_angle must use the EXACT consumer language from the reviews — not polished marketing speak.
6. Top comments: pick 8-10 of the most signal-rich comments across platforms.
7. TikTok hashtags: extract real ones from the tiktok data or infer from context.`;

  const raw = await claudeCall(system, userMsg, 6000);
  const parsed = parseJSON(raw);
  if (parsed) {
    parsed._competitorNames = competitorNames;
  }
  return parsed;
}

// ─── SIGNAL EXTRACTOR (for live feed) ────────────────────────

function extractLiveSignals(rawText, platform) {
  if (!rawText) return [];
  const lines = rawText.split("---").map(l=>l.trim()).filter(l=>l.length>20);
  return lines.slice(0,5).map(text => ({
    text: text.slice(0,120),
    platform,
    sentiment: detectSentiment(text),
  }));
}

function detectSentiment(text) {
  const t = text.toLowerCase();
  const neg = ["don't","doesnt","doesn't","roll","fall","tight","loose","bad","worst","hate","disappointed","waste","poor","fail","not good","uncomfortable","problem","issue"];
  const pos = ["love","perfect","amazing","great","excellent","best","good","comfortable","recommend","happy","satisfied","fits","quality","worth"];
  const negScore = neg.filter(w=>t.includes(w)).length;
  const posScore = pos.filter(w=>t.includes(w)).length;
  return negScore > posScore ? "negative" : posScore > negScore ? "positive" : "neutral";
}

// ─── VIDEO ───────────────────────────────────────────────────

async function assemblyaiProxy(path, method="GET", body=null) {
  const res = await fetch("/api/assemblyai", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({path, method, body}),
  });
  return await res.json();
}

async function shotstackProxy(path, method="POST", body=null) {
  const res = await fetch("/api/shotstack", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({path, method, body}),
  });
  return await res.json();
}

async function transcribeVideo(videoUrl) {
  try {
    const {id} = await assemblyaiProxy("/v2/transcript","POST",{audio_url:videoUrl,language_code:"en"});
    let status="processing", transcript="", attempts=0;
    while(["processing","queued"].includes(status) && attempts<30) {
      await new Promise(r=>setTimeout(r,5000));
      const poll = await assemblyaiProxy("/v2/transcript/"+id);
      status=poll.status;
      if(status==="completed") transcript=poll.text;
      attempts++;
    }
    return transcript;
  } catch(e) { console.error("Transcription failed:",e); return ""; }
}

async function extractFrames(videoUrl) {
  try {
    const probeData = await shotstackProxy("/v1/serve/probe","POST",{url:videoUrl});
    const duration = probeData?.response?.metadata?.duration || 20;
    const timestamps = [];
    for(let t=0; t<Math.min(duration,30); t+=5) timestamps.push(t);
    const frameUrls = [];
    for(const time of timestamps.slice(0,6)) {
      try {
        const renderData = await shotstackProxy("/v1/render","POST",{timeline:{tracks:[{clips:[{asset:{type:"video",src:videoUrl,trim:time},start:0,length:0.1}]}]},output:{format:"jpg",fps:1,size:{width:1280,height:720}}});
        const renderId = renderData?.response?.id;
        if(!renderId) continue;
        let renderStatus="queued", renderAttempts=0;
        while(renderStatus!=="done" && renderAttempts<15) {
          await new Promise(r=>setTimeout(r,3000));
          const checkData = await shotstackProxy("/v1/render/"+renderId,"GET");
          renderStatus=checkData?.response?.status;
          if(renderStatus==="done") frameUrls.push(checkData?.response?.url);
          renderAttempts++;
        }
      } catch(e) { console.error("Frame failed:",e); }
    }
    return frameUrls;
  } catch(e) { console.error("Shotstack failed:",e); return []; }
}

async function analyseVideo(transcript, frameUrls) {
  const textContent = `Analyse this winning ad video. Return pure JSON only:
{"hook":string,"script_structure":[strings],"visual_treatment":string,"text_overlays":[strings],"product_placement":string,"cta":string,"angle":string,"tone":string,"key_insight":string}
${transcript?"TRANSCRIPT:\n"+transcript:""}`;
  const raw = frameUrls.length>0
    ? await claudeVisionCall("You are a performance creative analyst. Return pure JSON only.",textContent,frameUrls)
    : await claudeCall("You are a performance creative analyst. Return pure JSON only.",textContent,1000);
  return parseJSON(raw) || {};
}

async function analyseScreenshots(screenshots) {
  if (!screenshots?.length) return [];
  const results = [];
  for (const screenshot of screenshots.slice(0,5)) {
    try {
      const base64 = await new Promise(r=>{const reader=new FileReader();reader.onloadend=()=>r(reader.result.split(",")[1]);reader.readAsDataURL(screenshot);});
      const content = [
        {type:"image",source:{type:"base64",media_type:screenshot.type||"image/jpeg",data:base64}},
        {type:"text",text:`Analyse this winning ad. Return pure JSON only: {"headline":string,"visual_hook":string,"angle":string,"format":string,"text_overlays":[strings],"cta":string,"why_it_works":string}`}
      ];
      const res = await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content}]})});
      const data = await res.json();
      const parsed = parseJSON(data.content?.find(b=>b.type==="text")?.text||"");
      if(parsed) results.push(parsed);
    } catch(e) { console.error("Screenshot analysis failed:",e); }
  }
  return results;
}

// ─── BRIEF GENERATION ────────────────────────────────────────

async function generateFullBrief(inputs) {
  const system = `You are the world's best performance marketing strategist for Indian D2C brands.

CORE PHILOSOPHY:
- Problem first. Product second. Brand last.
- Each ICP must be MUTUALLY EXCLUSIVE across ALL THREE axes: (1) different core problem, (2) different demographic profile, (3) different purchase trigger.
- The USP→Problem bridge is MANDATORY.
- Use REAL consumer language from the scraped data.
- Data attribution is mandatory.
- The Research Intelligence whitespace angles should DIRECTLY inform ICP creative angles.

Return ONLY valid JSON. No markdown, no backticks, no explanation.

{
  "brand": string,
  "product": string,
  "core_problem": string,
  "problem_keywords_used": [strings],
  "competitor_gap": string,
  "icps": [EXACTLY 3 objects],
  "global_ad_insights": {
    "what_works": [3 strings with data source],
    "angles_to_avoid": [3 strings],
    "fresh_angles": [3 strings],
    "competitor_whitespace": string
  }
}

EACH ICP OBJECT:
{
  "id": number,
  "type": "PRIMARY" or "SECONDARY",
  "profile": {
    "name": string,
    "age_range": string,
    "city_tier": string,
    "income_bracket": string,
    "lifestyle": string,
    "purchase_trigger": string,
    "purchase_blocker": string,
    "where_they_spend_time": [strings],
    "how_they_talk": string
  },
  "problem": {
    "core_problem": string,
    "problem_depth": string,
    "emotion_before_purchase": string,
    "emotion_after_purchase": string,
    "data_attribution": [strings],
    "real_quotes": [2-3 strings]
  },
  "usp_bridge": [
    { "consumer_problem": string, "product_usp": string, "proof_point": string, "creative_angle": string }
  ],
  "objection_map": [
    { "objection": string, "counter": string, "ad_line": string }
  ],
  "creative": {
    "hooks": [{ "hook": string, "type": string, "why_it_works": string }],
    "video_script": {
      "duration": string,
      "hook_line": string,
      "body": [{ "timestamp": string, "action": string, "dialogue": string, "delivery_note": string }],
      "cta": string,
      "creator_direction": string
    },
    "shot_list": [{ "shot_number": number, "shot_type": string, "action": string, "text_overlay": string, "duration": string }],
    "static_ad": { "headline": string, "body_copy": string, "usp_line": string, "cta": string },
    "body_copy_variations": [{ "angle": string, "copy": string }],
    "ugc_creator_brief": {
      "hook": string, "key_message": string, "must_show": [strings], "must_say": [strings], "must_not_say": [strings], "vibe": string, "outfit_props": string
    },
    "designer_brief": {
      "visual_style": string, "colour_direction": string, "typography_feel": string, "mood_board_keywords": [strings], "what_to_avoid": [strings], "text_overlay_style": string
    }
  },
  "proven_formula": {
    "winning_angle": string,
    "roas": string,
    "format": string,
    "why_it_works": string,
    "do_this": string,
    "dont_do_this": string
  },
  "concepts": [{ "concept": string, "format": string, "rationale": string, "data_source": string }],
  "performance": {
    "recommended_formats": [strings], "primary_placement": string, "budget_split_suggestion": string, "kpis": [strings], "success_looks_like": string, "testing_order": string
  }
}`;

  const reviewData = [
    inputs.amazonData   ? "AMAZON REVIEWS:\n"+inputs.amazonData.slice(0,900)   : "",
    inputs.flipkartData ? "\nFLIPKART REVIEWS:\n"+inputs.flipkartData.slice(0,700)   : "",
    inputs.myntraData   ? "\nMYNTRA REVIEWS:\n"+inputs.myntraData.slice(0,500)        : "",
    inputs.redditData   ? "\nREDDIT DISCUSSIONS:\n"+inputs.redditData.slice(0,700)    : "",
    inputs.youtubeData  ? "\nYOUTUBE COMMENTS:\n"+inputs.youtubeData.slice(0,600)    : "",
    inputs.tiktokData   ? "\nTIKTOK:\n"+inputs.tiktokData.slice(0,400)               : "",
    inputs.instagramData? "\nINSTAGRAM:\n"+inputs.instagramData.slice(0,400)         : "",
    inputs.quoraData    ? "\nQUORA DISCUSSIONS:\n"+inputs.quoraData.slice(0,500)     : "",
  ].filter(Boolean).join("\n");

  // Inject research intelligence into the prompt
  const windsorContext = inputs.windsorAngles ? (
"WINDSOR AI — REAL META AD PERFORMANCE (Last 30 days):\n" +
"TOP PERFORMING CREATIVES:\n" +
(inputs.windsorAngles.top_performers||[]).map((p,i)=>
  (i+1)+". "+p.creative_name.slice(0,80)+" — "+p.roas+"x ROAS, ₹"+p.spend.toLocaleString()+" spend, "+p.purchases+" orders, "+p.ctr+"% CTR ["+p.format+" | "+p.product+" | "+p.contentType+(p.creator?" | "+p.creator:"")+"]"+(p.hook_rate!=null?" Hook:"+p.hook_rate+"% Hold:"+p.hold_rate+"%":"")
).join("\n") + "\n" +
"FATIGUED ANGLES (do NOT repeat):\n" +
(inputs.windsorAngles.fatigued_angles||[]).map((f,i)=>
  (i+1)+". "+f.creative_name.slice(0,80)+" — "+f.roas+"x ROAS on ₹"+f.spend.toLocaleString()+" spend ["+f.format+" | "+f.product+" | "+f.contentType+"]"
).join("\n") + "\n" +
"FORMAT BREAKDOWN: "+Object.entries(inputs.windsorAngles.format_performance||{}).map(([k,v])=>k+": "+v.avg_roas+"x avg ROAS, "+v.count+" ads, ₹"+Math.round((v.total_spend||0)/1000)+"K").join(" | ")+"\n"+
"PRODUCT BREAKDOWN:\n"+(inputs.windsorAngles.product_performance||[]).map(p=>p.product+": "+p.avg_roas+"x ROAS, "+p.count+" ads, ₹"+Math.round(p.total_spend/1000)+"K spend").join("\n")+"\n"+
"CONTENT TYPE: "+(inputs.windsorAngles.content_type_performance||[]).map(c=>c.type+": "+c.avg_roas+"x ROAS, "+c.count+" ads").join(" | ")+"\n"+
"Map each ICP proven_formula to a real top performer. Flag fatigued angles explicitly. Use product/content-type data to decide which angle to double down on.\n"
) : "No Windsor data — generate proven_formula from research intelligence only.\n";

  const metaAdsContext = inputs.metaAdsInsights ? (
"META ADS LIBRARY — COMPETITOR CREATIVE INTELLIGENCE:\n" +
"Total active ads analysed: "+inputs.metaAdsInsights.total_ads+"\n" +
"Brands scraped: "+(inputs.metaAdsInsights.brands_analysed||[]).join(", ")+"\n" +
"Format split: "+inputs.metaAdsInsights.format_split?.video+" video / "+inputs.metaAdsInsights.format_split?.static+" static\n" +
"TOP COMPETITOR HOOKS RUNNING RIGHT NOW:\n" +
(inputs.metaAdsInsights.active_hooks||[]).slice(0,10).map((h,i)=>(i+1)+". \""+h+"\"").join("\n") + "\n" +
"TOP CTAs IN USE: "+(inputs.metaAdsInsights.top_ctas||[]).map(c=>c.cta+"("+c.count+"x)").join(", ")+"\n" +
"Use this to identify competitor creative patterns to differentiate against. Do NOT copy — use to find gaps.\n"
) : "No Meta Ads Library data available.\n";

  const researchContext = inputs.researchIntelligence ? (
"RESEARCH INTELLIGENCE — WHITESPACE ANGLES ALREADY IDENTIFIED:\n" +
(inputs.researchIntelligence.pain_themes||[]).slice(0,5).map(t=>
  "- \""+t.theme+"\" (score "+t.whitespace_score+"/10): "+(t.whitespace_angle?.hook||"")
).join("\n") + "\n\n" +
"GLOBAL WHITESPACE: "+(inputs.researchIntelligence.global_whitespace||"") + "\n\n" +
"Use these whitespace angles as the creative foundation for ICP briefs. Each ICP should own one of the top whitespace angles."
) : "";

  const visualIntelContext = inputs.creativeIntelData ? (
"VISUAL INTELLIGENCE — VISION AI ANALYSIS OF TOP ADS BY ROAS:\n" +
"Creatives vision-tagged: "+inputs.creativeIntelData.total_analysed+" | Overall avg ROAS: "+inputs.creativeIntelData.avg_roas_all+"x\n\n" +
"VISUAL PATTERNS RANKED BY ROAS LIFT:\n" +
Object.entries(inputs.creativeIntelData.correlations||{}).map(([dim,rows])=>{
  const top3 = (rows||[]).slice(0,3).map(r=>r.tag.replace(/_/g," ")+" ("+r.avg_roas+"x, "+(r.lift>=0?"+":"")+r.lift+"% vs avg)").join(" · ");
  return "  "+dim.replace(/_/g," ").toUpperCase()+": "+top3;
}).join("\n") + "\n\n" +
"TOP CREATIVES (VISION-TAGGED):\n" +
(inputs.creativeIntelData.top_creatives||[]).slice(0,5).map((c,i)=>{
  const tags = Object.entries(c.visualTags||{}).map(([k,v])=>k.replace(/_/g," ")+": "+v.replace(/_/g," ")).join(", ");
  return (i+1)+". "+c.adName.slice(0,70)+" — "+c.roas+"x ROAS | "+tags;
}).join("\n") + "\n\n" +
"APPLY VISUAL INTELLIGENCE TO EACH ICP:\n" +
"- designer_brief.visual_style → use highest-ROAS background and composition\n" +
"- designer_brief.colour_direction → use highest-ROAS color_palette values\n" +
"- ugc_creator_brief.vibe and outfit_props → mirror highest-ROAS person_type\n" +
"- concepts[].format → prioritise formats with highest lift\n" +
"- video_script hook_type → use the hook_type with highest ROAS lift\n"
) : "";

  const userPrompt = `BRAND: ${inputs.urlIntelligence.brand_name||""}
PRODUCT: ${inputs.urlIntelligence.product_name||""}
CORE PROBLEM SOLVED: ${inputs.urlIntelligence.core_problem_solved||""}
PRICE POINT: ${inputs.urlIntelligence.price_point||""}
TARGET AUDIENCE: ${inputs.urlIntelligence.target_audience||""}

PRODUCT USPs:
${(inputs.finalUSPs||[]).map((u,i)=>(i+1)+". "+u).join("\n")}

MEDIA BUYER KEYWORDS: ${inputs.mediaKeywords||"Not provided"}

BRAND CONTEXT:
- Tone: ${inputs.brandContext?.toneOfVoice||"Not provided"}
- Ad Spend: ${inputs.brandContext?.adSpend||"Not provided"}
- Target ROAS: ${inputs.brandContext?.targetRoas||"Not provided"}
- Tested Angles: ${inputs.brandContext?.testedAngles||"Not provided"}
- Winning Copies: ${inputs.brandContext?.winningCopies||"Not provided"}
- Current Offers: ${inputs.brandContext?.currentOffers||"Not provided"}

${windsorContext}
${metaAdsContext}
${researchContext}
${visualIntelContext}
SCRAPED DATA FROM 9 SOURCES:
${reviewData||"No review data scraped — generate from URL intelligence only."}

INSTRUCTIONS:
1. Generate EXACTLY 3 ICPs. Mutually exclusive on problem + demographic + trigger.
2. Map every problem to a specific product USP.
3. Use real quotes and phrases from the scraped data.
4. Attribute every key insight to its data source.
5. Video script must be verbatim.
6. Each ICP must own one of the whitespace angles from Research Intelligence.`;

  const raw = await claudeCall(system, userPrompt, 10000);
  const parsed = parseJSON(raw);
  if(parsed) {
    parsed.brand = inputs.urlIntelligence.brand_name||"";
    parsed.product = inputs.urlIntelligence.product_name||"";
  }
  return parsed;
}

// ─── UI COMPONENTS ───────────────────────────────────────────

function Section({title, children, accent=false}) {
  return (
    <div style={{marginBottom:"32px"}}>
      <div style={{display:"flex",alignItems:"center",gap:"14px",marginBottom:"14px",fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:"0.18em",textTransform:"uppercase",color:accent?T.accent:T.muted}}>
        <span>{title}</span>
        <div style={{flex:1,height:"1px",background:T.rule}}/>
      </div>
      {children}
    </div>
  );
}

function Card({children,style={}}) {
  return <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"16px",...style}}>{children}</div>;
}

function Label({children,color}) {
  return <span style={{display:"block",fontFamily:"'DM Mono',monospace",fontSize:"9px",letterSpacing:"0.15em",textTransform:"uppercase",color:color||T.muted,marginBottom:"6px"}}>{children}</span>;
}

function Tag({children,color="accent"}) {
  const colors = {accent:"rgba(200,75,47,0.15)",green:"rgba(76,175,80,0.15)",blue:"rgba(100,160,255,0.15)",muted:"rgba(255,255,255,0.06)"};
  const textColors = {accent:T.accent,green:T.green,blue:T.blue,muted:T.muted};
  return <span style={{display:"inline-block",padding:"3px 10px",borderRadius:"3px",fontSize:"11px",fontFamily:"'DM Mono',monospace",background:colors[color]||colors.accent,color:textColors[color]||textColors.accent,marginRight:"6px",marginBottom:"6px"}}>{children}</span>;
}

function InputField({label,value,onChange,placeholder,required,hint}) {
  const [focused,setFocused] = useState(false);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
      <label style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:"0.15em",textTransform:"uppercase",color:required?"rgba(200,75,47,0.8)":"rgba(255,255,255,0.35)"}}>
        {label} {required&&<span style={{color:T.accent}}>*</span>}
        {hint&&<span style={{marginLeft:"8px",fontWeight:"normal",color:T.muted,textTransform:"none",letterSpacing:"normal",fontSize:"10px"}}>{hint}</span>}
      </label>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
        style={{background:focused?"rgba(200,75,47,0.04)":T.card,border:"1px solid "+(focused?"rgba(200,75,47,0.5)":T.cardBorder),borderRadius:"6px",padding:"11px 14px",fontSize:"14px",color:T.ink,outline:"none",fontFamily:"'DM Sans',sans-serif",width:"100%",boxSizing:"border-box",transition:"all 0.2s"}}/>
    </div>
  );
}

function TextArea({label,value,onChange,placeholder,rows=3,hint}) {
  const [focused,setFocused] = useState(false);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
      <label style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:"0.15em",textTransform:"uppercase",color:"rgba(255,255,255,0.35)"}}>
        {label}
        {hint&&<span style={{marginLeft:"8px",fontWeight:"normal",color:T.muted,textTransform:"none",letterSpacing:"normal",fontSize:"10px"}}>{hint}</span>}
      </label>
      <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows}
        onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
        style={{background:focused?"rgba(200,75,47,0.04)":T.card,border:"1px solid "+(focused?"rgba(200,75,47,0.5)":T.cardBorder),borderRadius:"6px",padding:"11px 14px",fontSize:"14px",color:T.ink,outline:"none",fontFamily:"'DM Sans',sans-serif",width:"100%",boxSizing:"border-box",resize:"vertical",transition:"all 0.2s"}}/>
    </div>
  );
}

function MultiUrlInput({label,values,onChange,placeholder,required,minCount,hint,note}) {
  const add = ()=>onChange([...values,""]);
  const update = (i,v)=>{const n=[...values];n[i]=v;onChange(n);};
  const remove = (i)=>{if(values.length>1) onChange(values.filter((_,idx)=>idx!==i));};
  const filled = values.filter(v=>v.trim()).length;
  const isValid = !required||filled>=minCount;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <label style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:"0.15em",textTransform:"uppercase",color:required?"rgba(200,75,47,0.8)":"rgba(255,255,255,0.35)"}}>
          {label} {required&&<span style={{color:T.accent}}>*</span>}
        </label>
        {minCount&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:isValid?T.green:T.warn}}>{filled}/{minCount} {isValid?"✓":"needed"}</span>}
      </div>
      {note&&<div style={{fontSize:"11px",color:T.muted,fontFamily:"'DM Mono',monospace",background:"rgba(255,255,255,0.02)",padding:"6px 10px",borderRadius:"4px",borderLeft:"2px solid rgba(200,75,47,0.3)"}}>{note}</div>}
      {values.map((v,i)=>(
        <div key={i} style={{display:"flex",gap:"8px"}}>
          <input value={v} onChange={e=>update(i,e.target.value)} placeholder={placeholder}
            style={{flex:1,background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"10px 14px",fontSize:"13px",color:T.ink,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
          {values.length>1&&<button onClick={()=>remove(i)} style={{background:"none",border:"1px solid "+T.cardBorder,color:T.muted,borderRadius:"6px",padding:"8px 12px",cursor:"pointer",fontSize:"16px"}}>×</button>}
        </div>
      ))}
      <button onClick={add} style={{background:"none",border:"1px dashed "+T.cardBorder,color:T.muted,borderRadius:"6px",padding:"9px",cursor:"pointer",fontSize:"12px",fontFamily:"'DM Mono',monospace"}}>+ Add URL</button>
    </div>
  );
}

function USPEditor({usps, onChange, recommended}) {
  const update = (i,v)=>{const n=[...usps];n[i]=v;onChange(n);};
  const add = ()=>onChange([...usps,""]);
  const remove = (i)=>{if(usps.length>1) onChange(usps.filter((_,idx)=>idx!==i));};
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <label style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:"0.15em",textTransform:"uppercase",color:"rgba(200,75,47,0.8)"}}>Product USPs / Features <span style={{color:T.accent}}>*</span></label>
        <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.green}}>{usps.filter(u=>u.trim()).length} USPs added</span>
      </div>
      {recommended?.length>0&&(
        <div style={{background:"rgba(200,75,47,0.06)",border:"1px solid rgba(200,75,47,0.2)",borderRadius:"6px",padding:"10px 12px",fontSize:"11px",color:T.muted,lineHeight:"1.7"}}>
          <span style={{color:T.accent,fontFamily:"'DM Mono',monospace",fontSize:"9px",letterSpacing:"0.1em"}}>AUTO-EXTRACTED — EDIT OR ADD MORE</span>
        </div>
      )}
      {usps.map((u,i)=>(
        <div key={i} style={{display:"flex",gap:"8px",alignItems:"flex-start"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent,padding:"11px 0",flexShrink:0,minWidth:"20px"}}>#{i+1}</span>
          <input value={u} onChange={e=>update(i,e.target.value)} placeholder="e.g. StayUp waistband — no rolling, tested for 90min workouts"
            style={{flex:1,background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"10px 14px",fontSize:"13px",color:T.ink,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
          {usps.length>1&&<button onClick={()=>remove(i)} style={{background:"none",border:"1px solid "+T.cardBorder,color:T.muted,borderRadius:"6px",padding:"8px 12px",cursor:"pointer",fontSize:"16px",flexShrink:0}}>×</button>}
        </div>
      ))}
      <button onClick={add} style={{background:"none",border:"1px dashed "+T.cardBorder,color:T.muted,borderRadius:"6px",padding:"9px",cursor:"pointer",fontSize:"12px",fontFamily:"'DM Mono',monospace"}}>+ Add USP</button>
    </div>
  );
}

function TopBar({left,center,right}) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 40px",borderBottom:"1px solid "+T.rule,position:"sticky",top:0,background:T.bg,zIndex:10}}>
      <div>{left}</div><div>{center}</div><div>{right}</div>
    </div>
  );
}

// ─── STEP 1 ──────────────────────────────────────────────────

const STEP1_DRAFT_KEY = "briefengine_v6_step1_draft";

function Step1Screen({onNext}) {
  const draft = (() => { try { return JSON.parse(localStorage.getItem(STEP1_DRAFT_KEY)) || {}; } catch { return {}; } })();
  const [brandName,    setBrandName]    = useState(draft.brandName    || "");
  const [brandUrl,     setBrandUrl]     = useState(draft.brandUrl     || "");
  const [productUrl,   setProductUrl]   = useState(draft.productUrl   || "");
  const [mediaKeywords,setMediaKeywords]= useState(draft.mediaKeywords|| "");
  const [amazonUrls,   setAmazonUrls]   = useState(draft.amazonUrls   || ["","",""]);
  const [myntraUrl,    setMyntraUrl]    = useState(draft.myntraUrl    || "");
  const [youtubeUrls,  setYoutubeUrls]  = useState(draft.youtubeUrls  || ["",""]);
  const [instagramUrls,setInstagramUrls]= useState(draft.instagramUrls|| ["",""]);
  const [otherUrls,    setOtherUrls]    = useState(draft.otherUrls    || [""]);
  const [winsorApiKey, setWindsorApiKey]= useState(draft.winsorApiKey || "");
  const [competitorNames, setCompetitorNames]= useState(draft.competitorNames || "");
  const [creativeSheetRows, setCreativeSheetRows] = useState([]);
  const [sheetLoaded, setSheetLoaded] = useState(false);
  const [errors,       setErrors]       = useState([]);

  useEffect(() => {
    localStorage.setItem(STEP1_DRAFT_KEY, JSON.stringify({
      brandName, brandUrl, productUrl, mediaKeywords,
      amazonUrls, myntraUrl, youtubeUrls, instagramUrls, otherUrls,
      winsorApiKey, competitorNames,
    }));
  }, [brandName, brandUrl, productUrl, mediaKeywords, amazonUrls, myntraUrl, youtubeUrls, instagramUrls, otherUrls, winsorApiKey, competitorNames]);

  const baseReady = brandName.trim()&&brandUrl.trim()&&productUrl.trim();

  const handleSheetUpload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const rows = await parseCreativeSheet(file);
      setCreativeSheetRows(rows); setSheetLoaded(true);
    } catch(err) { alert("Failed to parse sheet: "+err.message); }
  };

  const handleNext = () => {
    const data = {brandName,brandUrl,productUrl,mediaKeywords,amazonUrls,myntraUrl,youtubeUrls,instagramUrls,otherUrls,winsorApiKey,competitorNames,creativeSheetRows};
    const errs = validateUrls(data);
    if(errs.length>0){setErrors(errs);return;}
    setErrors([]);
    onNext(data);
  };

  return (
    <div style={{minHeight:"100vh",background:T.bg,display:"flex",flexDirection:"column"}}>
      <TopBar
        left={<span style={{fontFamily:"'DM Mono',monospace",fontSize:"12px",letterSpacing:"0.2em",color:T.accent}}>BRIEF ENGINE</span>}
        center={<div style={{display:"flex",gap:"8px"}}><span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.accent}}>01 URLs</span><span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>→ 02 USPs & Context</span></div>}
        right={<span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>v6.2</span>}
      />
      <div style={{flex:1,maxWidth:"660px",margin:"0 auto",padding:"48px 24px",width:"100%"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,marginBottom:"12px",letterSpacing:"0.2em"}}>STEP 01 OF 02</div>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"32px",fontWeight:"700",color:T.ink,margin:"0 0 8px"}}>Add Your URLs</h1>
        <p style={{fontSize:"14px",color:T.muted,margin:"0 0 8px",lineHeight:"1.6"}}>8 sources scraped automatically. Flipkart, Reddit, TikTok and Quora run fully auto. Amazon, Myntra, YouTube and Instagram need your URLs.</p>
        <div style={{background:"rgba(200,75,47,0.08)",border:"1px solid rgba(200,75,47,0.2)",borderRadius:"6px",padding:"10px 14px",marginBottom:"32px",fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent}}>
          PROBLEM FIRST · USP BRIDGE · COMPETITOR GAP MATRIX · WHITESPACE ANGLES · MUTUALLY EXCLUSIVE ICPs
        </div>

        {errors.length>0&&(
          <div style={{background:"rgba(255,80,60,0.08)",border:"1px solid rgba(255,80,60,0.3)",borderRadius:"6px",padding:"16px",marginBottom:"24px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#ff6040",marginBottom:"10px",letterSpacing:"0.1em"}}>MISSING REQUIRED FIELDS</div>
            {errors.map((e,i)=><div key={i} style={{fontSize:"13px",color:"rgba(255,120,100,0.9)",marginBottom:"6px"}}>✕ {e}</div>)}
          </div>
        )}

        <div style={{display:"flex",flexDirection:"column",gap:"20px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent,letterSpacing:"0.15em"}}>REQUIRED — BRAND & PRODUCT</div>
          <InputField label="Brand Name" value={brandName} onChange={setBrandName} placeholder="e.g. BlissClub" required/>
          <InputField label="Brand URL" value={brandUrl} onChange={setBrandUrl} placeholder="https://blissclub.com" required/>
          <InputField label="Product URL" value={productUrl} onChange={setProductUrl} placeholder="https://blissclub.com/products/movement-leggings" required/>

          <div style={{background:"rgba(100,160,255,0.06)",border:"1px solid rgba(100,160,255,0.2)",borderRadius:"6px",padding:"14px 16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.blue,letterSpacing:"0.12em",marginBottom:"8px"}}>MEDIA BUYER KEYWORDS — IMPORTANT</div>
            <p style={{fontSize:"12px",color:T.muted,margin:"0 0 12px",lineHeight:"1.6"}}>How do YOU describe this product? What words come to mind when you think about who buys it and why?</p>
            <TextArea label="" value={mediaKeywords} onChange={setMediaKeywords} placeholder="e.g. active Indian women, gym to brunch, leggings that don't fall down, body-confident, size-inclusive..." rows={2}/>
          </div>

          <div style={{height:"1px",background:T.rule}}/>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent,letterSpacing:"0.15em"}}>REQUIRED — REVIEW SOURCES</div>
          <div style={{background:"rgba(200,75,47,0.04)",border:"1px solid rgba(200,75,47,0.12)",borderRadius:"6px",padding:"10px 14px",fontSize:"11px",color:T.muted,lineHeight:"1.8",fontFamily:"'DM Mono',monospace"}}>
            Competitor brand names are auto-extracted from these URLs — no manual input needed. Reviews scraped from ALL of them for competitor gap analysis.
          </div>

          <MultiUrlInput label="Amazon India Product URLs" values={amazonUrls} onChange={setAmazonUrls}
            placeholder="https://amazon.in/dp/XXXXXXXXXX" required minCount={3}
            note="Your brand's listing + 2-3 competitors. Competitor names auto-detected for gap matrix."/>

          <InputField label="Myntra Product URL" value={myntraUrl} onChange={setMyntraUrl} placeholder="https://myntra.com/..." required/>

          <div style={{height:"1px",background:T.rule}}/>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent,letterSpacing:"0.15em"}}>REQUIRED — VIDEO & SOCIAL</div>
          <MultiUrlInput label="YouTube Review / Haul Video URLs" values={youtubeUrls} onChange={setYoutubeUrls}
            placeholder="https://youtube.com/watch?v=..." required minCount={2}
            note="Honest reviews, haul videos, product comparisons."/>

          <MultiUrlInput label="Instagram URLs (brand + competitors)" values={instagramUrls} onChange={setInstagramUrls}
            placeholder="https://instagram.com/blissclub" required minCount={2}
            note="Brand profile + 1-2 competitor profiles."/>

          <div style={{height:"1px",background:T.rule}}/>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.15em"}}>OPTIONAL — EXTRA CONTEXT</div>
          <MultiUrlInput label="Other URLs" values={otherUrls} onChange={setOtherUrls} placeholder="https://..."/>

          <div style={{background:"rgba(76,175,80,0.06)",border:"1px solid rgba(76,175,80,0.2)",borderRadius:"6px",padding:"14px 16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.green,letterSpacing:"0.12em",marginBottom:"6px"}}>WINDSOR AI — META AD PERFORMANCE (OPTIONAL)</div>
            <p style={{fontSize:"11px",color:T.muted,margin:"0 0 10px",lineHeight:"1.6"}}>Paste your Windsor API key to pull real CTR, ROAS and spend per creative. Enables the Proven Formula section in each ICP. Get it from windsor.ai → Settings → API Key.</p>
            <InputField label="Windsor API Key" value={winsorApiKey} onChange={setWindsorApiKey} placeholder="wai_xxxxxxxxxxxxxxxxxxxxxxxx"/>
          </div>

          <div style={{background:"rgba(180,120,255,0.06)",border:"1px solid rgba(180,120,255,0.2)",borderRadius:"6px",padding:"14px 16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#b39ddb",letterSpacing:"0.12em",marginBottom:"6px"}}>CREATIVE SHEET — VISION AI ANALYSIS (OPTIONAL)</div>
            <p style={{fontSize:"11px",color:T.muted,margin:"0 0 10px",lineHeight:"1.6"}}>Upload the Blissclub creative sheet (.xlsx). Joins with Windsor on AD Name → fetches Drive thumbnails → Vision AI tags top 10 creatives → shows which visual patterns correlate with high ROAS.</p>
            <label style={{display:"block",cursor:"pointer"}}>
              <div style={{border:"1px dashed rgba(180,120,255,0.3)",borderRadius:"6px",padding:"14px",textAlign:"center",fontFamily:"'DM Mono',monospace",fontSize:"11px",color:sheetLoaded?"#b39ddb":T.muted,transition:"all 0.2s"}}>
                {sheetLoaded ? `✓ ${creativeSheetRows.length} creatives loaded` : "Click to upload .xlsx / .xls / .csv"}
              </div>
              <input type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleSheetUpload}/>
            </label>
          </div>

          <div style={{background:"rgba(100,160,255,0.06)",border:"1px solid rgba(100,160,255,0.2)",borderRadius:"6px",padding:"14px 16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.blue,letterSpacing:"0.12em",marginBottom:"6px"}}>META ADS LIBRARY — COMPETITOR SCRAPING (OPTIONAL)</div>
            <p style={{fontSize:"11px",color:T.muted,margin:"0 0 10px",lineHeight:"1.6"}}>Add competitor brand names to scrape their active Meta ads. Helps Claude identify what angles competitors are running so your brief can differentiate.</p>
            <InputField label="Competitor brand names (comma separated)" value={competitorNames} onChange={setCompetitorNames} placeholder="e.g. Nykaa, Decathlon, Clovia, Zivame"/>
          </div>

          <div style={{background:"rgba(76,175,80,0.06)",border:"1px solid rgba(76,175,80,0.15)",borderRadius:"6px",padding:"12px 14px",fontSize:"11px",color:T.muted,lineHeight:"1.8",fontFamily:"'DM Mono',monospace"}}>
            <span style={{color:T.green}}>AUTO</span> — Flipkart · Reddit · TikTok · Quora · Meta Ads Library run fully automatically. No URLs needed.
          </div>

          <button onClick={handleNext} disabled={!baseReady}
            style={{background:baseReady?T.accent:"rgba(255,255,255,0.07)",color:baseReady?T.ink:"rgba(255,255,255,0.2)",border:"none",borderRadius:"6px",padding:"16px 24px",fontSize:"15px",fontWeight:"600",cursor:baseReady?"pointer":"not-allowed",fontFamily:"'DM Sans',sans-serif",marginTop:"8px"}}>
            Next — USPs & Brand Context →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── STEP 2 ──────────────────────────────────────────────────

function Step2Screen({urlData, onGenerate, onBack}) {
  const saved = getSavedBrand(urlData.brandName) || {};
  const [usps,          setUsps]          = useState(saved.usps || ["","","",""]);
  const [extractedUsps, setExtractedUsps] = useState([]);
  const [uspLoading,    setUspLoading]    = useState(false);
  const [toneOfVoice,   setToneOfVoice]   = useState(saved.toneOfVoice   || "");
  const [adSpend,       setAdSpend]       = useState(saved.adSpend       || "");
  const [targetRoas,    setTargetRoas]    = useState(saved.targetRoas    || "");
  const [winningCopies, setWinningCopies] = useState(saved.winningCopies || "");
  const [testedAngles,  setTestedAngles]  = useState(saved.testedAngles  || "");
  const [killedCreatives,setKilledCreatives]=useState(saved.killedCreatives||"");
  const [currentOffers, setCurrentOffers] = useState(saved.currentOffers || "");
  const [winningAdUrls, setWinningAdUrls] = useState(saved.winningAdUrls || [""]);
  const [screenshots,   setScreenshots]   = useState([]);
  const hasSaved = !!getSavedBrand(urlData.brandName);

  useEffect(() => {
    if (!urlData.brandName) return;
    saveBrand(urlData.brandName, {usps, toneOfVoice, adSpend, targetRoas, winningCopies, testedAngles, killedCreatives, currentOffers, winningAdUrls});
  }, [usps, toneOfVoice, adSpend, targetRoas, winningCopies, testedAngles, killedCreatives, currentOffers, winningAdUrls]);

  useEffect(() => {
    if (saved.usps?.filter(u=>u.trim()).length > 0) return;
    setUspLoading(true);
    claudeCall(
      "Extract product USPs from URL. Return pure JSON only: {\"usps\":[6-8 specific feature strings]}",
      "Product URL: "+urlData.productUrl+"\nBrand URL: "+urlData.brandUrl
    ).then(raw => {
      const parsed = parseJSON(raw);
      if (parsed?.usps?.length > 0) { setUsps(parsed.usps); setExtractedUsps(parsed.usps); }
      setUspLoading(false);
    }).catch(()=>setUspLoading(false));
  }, []);

  const handleGenerate = () => {
    const context = {usps,toneOfVoice,adSpend,targetRoas,winningCopies,testedAngles,killedCreatives,currentOffers,winningAdUrls};
    saveBrand(urlData.brandName, context);
    onGenerate({...urlData, finalUSPs:usps.filter(u=>u.trim()), brandContext:context, screenshots});
  };

  return (
    <div style={{minHeight:"100vh",background:T.bg,display:"flex",flexDirection:"column"}}>
      <TopBar
        left={<button onClick={onBack} style={{background:"none",border:"1px solid "+T.rule,color:T.muted,padding:"8px 16px",borderRadius:"4px",cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:"11px"}}>← Back</button>}
        center={<div style={{display:"flex",gap:"8px"}}><span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>01 URLs →</span><span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.accent}}>02 USPs & Context</span></div>}
        right={<span/>}
      />
      <div style={{flex:1,maxWidth:"660px",margin:"0 auto",padding:"48px 24px",width:"100%"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,marginBottom:"12px",letterSpacing:"0.2em"}}>STEP 02 OF 02</div>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"32px",fontWeight:"700",color:T.ink,margin:"0 0 8px"}}>USPs & Brand Context</h1>
        <p style={{fontSize:"14px",color:T.muted,margin:"0 0 24px",lineHeight:"1.6"}}>USPs are auto-extracted from your product page. Edit for accuracy.</p>

        {hasSaved&&<div style={{background:"rgba(80,220,100,0.06)",border:"1px solid rgba(80,220,100,0.2)",borderRadius:"6px",padding:"10px 14px",marginBottom:"24px",fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.green}}>✓ Loaded saved context for {urlData.brandName}</div>}

        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          {uspLoading
            ? <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"20px",textAlign:"center",fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>Extracting USPs from product page...</div>
            : <USPEditor usps={usps} onChange={setUsps} recommended={extractedUsps}/>
          }
          <div style={{height:"1px",background:T.rule}}/>
          <TextArea label="Tone of Voice / Brand Guidelines" value={toneOfVoice} onChange={setToneOfVoice} placeholder="e.g. Bold, no-nonsense. Speaks to the modern Indian woman. Never preachy." rows={3}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px"}}>
            <InputField label="Monthly Ad Spend" value={adSpend} onChange={setAdSpend} placeholder="e.g. ₹5–10L/month"/>
            <InputField label="Target ROAS / CPA" value={targetRoas} onChange={setTargetRoas} placeholder="e.g. 3x ROAS / ₹800 CPA"/>
          </div>
          <TextArea label="Winning Ad Copies" value={winningCopies} onChange={setWinningCopies} placeholder="Paste 1–3 best performing copies. Separate with ---" rows={4}/>
          <TextArea label="Angles Already Tested" value={testedAngles} onChange={setTestedAngles} placeholder="e.g. Fabric quality angle — tested Jan 2026, fatigued." rows={3}/>
          <div style={{background:"rgba(255,100,80,0.04)",border:"1px solid rgba(255,100,80,0.15)",borderRadius:"6px",padding:"14px 16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.red,letterSpacing:"0.12em",marginBottom:"6px"}}>KILLED CREATIVES LOG</div>
            <p style={{fontSize:"11px",color:T.muted,margin:"0 0 10px",lineHeight:"1.6"}}>Paste dead angles with spend + reason. The tool will never suggest these again.</p>
            <TextArea label="" value={killedCreatives} onChange={setKilledCreatives} placeholder={"e.g.\nFabric close-up — ₹45,000 — CTR 0.4%, fatigued\nFounder story — ₹28,000 — low purchase intent"} rows={3}/>
          </div>

          <TextArea label="Current Offers Running" value={currentOffers} onChange={setCurrentOffers} placeholder="e.g. FIRSTBLISS — 10% off first order." rows={2}/>
          <MultiUrlInput label="Winning Ad Video URLs (YouTube)" values={winningAdUrls} onChange={setWinningAdUrls} placeholder="https://youtube.com/watch?v=..."/>

          <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
            <label style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:"0.15em",textTransform:"uppercase",color:"rgba(255,255,255,0.35)"}}>Winning Ad Screenshots (upload up to 5)</label>
            <label style={{background:T.card,border:"1px dashed "+T.cardBorder,borderRadius:"6px",padding:"16px",cursor:"pointer",textAlign:"center",color:T.muted,fontSize:"13px"}}>
              {screenshots.length>0?screenshots.length+" screenshot"+(screenshots.length>1?"s":"")+" uploaded ✓":"Click to upload screenshots"}
              <input type="file" accept="image/*" multiple onChange={e=>setScreenshots(prev=>[...prev,...Array.from(e.target.files||[])].slice(0,5))} style={{display:"none"}}/>
            </label>
          </div>

          <button onClick={handleGenerate}
            style={{background:T.accent,color:T.ink,border:"none",borderRadius:"6px",padding:"16px 24px",fontSize:"15px",fontWeight:"600",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",marginTop:"8px"}}>
            Scrape 9 Sources & Generate Deep Brief →
          </button>
          <p style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"rgba(255,255,255,0.2)",textAlign:"center",margin:0}}>~$0.85/brief · 12–18 min · 9 sources + Research Intelligence · Context saves automatically</p>
        </div>
      </div>
    </div>
  );
}

// ─── LOADING SCREEN WITH LIVE FEED ───────────────────────────

function LoadingScreen({brand, progress, liveSignals, dataPoints, windsorLoaded}) {
  const feedRef = useRef(null);

  useEffect(()=>{
    if(feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  },[liveSignals]);

  const PLATFORM_COLORS = {
    amazon:  { bg:"rgba(255,153,0,0.12)", text:"#ff9900", label:"Amazon" },
    flipkart:{ bg:"rgba(40,116,240,0.12)", text:"#2874f0", label:"Flipkart" },
    myntra:  { bg:"rgba(255,63,108,0.12)", text:"#ff3f6c", label:"Myntra" },
    reddit:  { bg:"rgba(255,69,0,0.12)", text:"#ff4500", label:"Reddit" },
    youtube: { bg:"rgba(255,0,0,0.1)", text:"#ff0000", label:"YouTube" },
    tiktok:  { bg:"rgba(105,201,208,0.12)", text:"#69c9d0", label:"TikTok" },
    instagram:{ bg:"rgba(200,75,180,0.12)", text:"#c84bb4", label:"Instagram" },
    quora:   { bg:"rgba(167,37,5,0.12)", text:"#a72505", label:"Quora" },
  };

  const completedCount = Object.values(progress).filter(v=>v==="done"||v==="failed").length;
  const totalCount = PIPELINE_STEPS.length;

  return (
    <div style={{minHeight:"100vh",background:T.bg,display:"flex",flexDirection:"column"}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div style={{display:"flex",flex:1,gap:0}}>

        {/* Left — pipeline */}
        <div style={{width:"380px",flexShrink:0,borderRight:"1px solid "+T.rule,padding:"40px 32px",display:"flex",flexDirection:"column",gap:"24px"}}>
          <div style={{display:"flex",alignItems:"center",gap:"14px"}}>
            <div style={{width:"36px",height:"36px",position:"relative",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <div style={{position:"absolute",inset:0,borderRadius:"50%",border:"2px solid rgba(200,75,47,0.15)",borderTop:"2px solid "+T.accent,animation:"spin 1s linear infinite"}}/>
              <div style={{width:"6px",height:"6px",borderRadius:"50%",background:T.accent}}/>
            </div>
            <div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:"16px",fontWeight:"700",color:T.ink}}>{brand}</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,marginTop:"2px"}}>{completedCount}/{totalCount} steps complete</div>
            </div>
          </div>

          {windsorLoaded && (
            <div style={{background:"rgba(76,175,80,0.08)",border:"1px solid rgba(76,175,80,0.2)",borderRadius:"6px",padding:"8px 12px",display:"flex",alignItems:"center",gap:"8px"}}>
              <div style={{width:"6px",height:"6px",borderRadius:"50%",background:T.green,flexShrink:0}}/>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.green}}>Meta performance data loaded</span>
            </div>
          )}

          {/* Progress bar */}
          <div style={{height:"2px",background:"rgba(255,255,255,0.06)",borderRadius:"1px",overflow:"hidden"}}>
            <div style={{height:"100%",background:T.accent,borderRadius:"1px",width:(completedCount/totalCount*100)+"%",transition:"width 0.5s ease"}}/>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:"4px"}}>
            {PIPELINE_STEPS.map(({key,label})=>{
              const state = progress[key]||"pending";
              return (
                <div key={key} style={{display:"flex",alignItems:"center",gap:"10px",padding:"8px 12px",borderRadius:"5px",background:state==="running"?"rgba(200,75,47,0.08)":state==="done"?"rgba(76,175,80,0.04)":state==="failed"?"rgba(244,67,54,0.05)":"transparent",border:"1px solid "+(state==="running"?"rgba(200,75,47,0.3)":state==="done"?"rgba(76,175,80,0.1)":state==="failed"?"rgba(244,67,54,0.25)":"transparent"),transition:"all 0.3s"}}>
                  <div style={{width:"6px",height:"6px",borderRadius:"50%",flexShrink:0,background:state==="done"?T.green:state==="failed"?"#f44336":state==="running"?T.accent:"rgba(255,255,255,0.1)"}}/>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:state==="pending"?T.muted:T.ink,flex:1,lineHeight:"1.4"}}>{label}</span>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:state==="done"?T.green:state==="failed"?"rgba(244,67,54,0.7)":state==="running"?T.accent:T.muted,flexShrink:0}}>
                    {state==="done"?"✓":state==="failed"?"✗":state==="running"?"...":"—"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Data point counters */}
          {Object.keys(dataPoints).length > 0 && (
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,letterSpacing:"0.12em",marginBottom:"8px"}}>SIGNALS COLLECTED</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px"}}>
                {Object.entries(dataPoints).map(([platform,count])=>(
                  <div key={platform} style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"4px",padding:"6px 10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,textTransform:"capitalize"}}>{platform}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.green,fontWeight:"500"}}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right — live signal feed */}
        <div style={{flex:1,padding:"40px 40px",display:"flex",flexDirection:"column",gap:"16px",overflow:"hidden"}}>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent,letterSpacing:"0.15em",marginBottom:"4px"}}>LIVE SIGNAL FEED</div>
            <div style={{fontSize:"13px",color:T.muted}}>Real consumer voice as it's scraped — this becomes your brief</div>
          </div>

          {liveSignals.length === 0 ? (
            <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:"12px"}}>
              <div style={{width:"40px",height:"40px",borderRadius:"50%",border:"1px solid "+T.cardBorder,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <div style={{width:"6px",height:"6px",borderRadius:"50%",background:T.muted,animation:"spin 2s linear infinite"}}/>
              </div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>Waiting for first signals...</div>
            </div>
          ) : (
            <div ref={feedRef} style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:"8px"}}>
              {liveSignals.map((signal,i)=>{
                const pc = PLATFORM_COLORS[signal.platform] || PLATFORM_COLORS.amazon;
                const sentColor = signal.sentiment==="positive"?"#4caf50":signal.sentiment==="negative"?"rgba(255,100,80,0.9)":"rgba(255,255,255,0.3)";
                const sentBg = signal.sentiment==="positive"?"rgba(76,175,80,0.08)":signal.sentiment==="negative"?"rgba(255,100,80,0.06)":"transparent";
                return (
                  <div key={i} style={{animation:"slideUp 0.35s ease forwards",background:sentBg,border:"1px solid "+(signal.sentiment==="positive"?"rgba(76,175,80,0.15)":signal.sentiment==="negative"?"rgba(255,100,80,0.15)":T.cardBorder),borderLeft:"3px solid "+sentColor,borderRadius:"6px",padding:"10px 14px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
                      <span style={{fontSize:"9px",padding:"2px 8px",borderRadius:"3px",fontFamily:"'DM Mono',monospace",fontWeight:"500",background:pc.bg,color:pc.text}}>{pc.label}</span>
                      <span style={{fontSize:"9px",color:sentColor,fontFamily:"'DM Mono',monospace"}}>{signal.sentiment}</span>
                    </div>
                    <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.5",fontStyle:"italic"}}>"{signal.text}"</div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"rgba(255,255,255,0.15)",textAlign:"center"}}>Do not close this tab · ~$0.85/brief · 9 sources + Research Intelligence</div>
        </div>
      </div>
    </div>
  );
}

// ─── RESEARCH INTELLIGENCE TAB ────────────────────────────────

function ResearchIntelligenceTab({data}) {
  const [activeTheme, setActiveTheme] = useState(0);
  const [commentFilter, setCommentFilter] = useState("all");
  const [commentSort, setCommentSort] = useState("freq");

  if (!data) return (
    <div style={{padding:"40px",textAlign:"center",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"12px"}}>
      Research Intelligence not available for this brief.
    </div>
  );

  const themes = data.pain_themes || [];
  const summary = data.data_summary || {};
  const competitors = data._competitorNames || [];
  const topComments = data.top_comments || [];
  const hashtags = data.tiktok_hashtags || [];

  const PLATFORM_COLORS = {
    amazon:"#ff9900", flipkart:"#2874f0", myntra:"#ff3f6c",
    reddit:"#ff4500", youtube:"#ff0000", tiktok:"#69c9d0",
    instagram:"#c84bb4", quora:"#a72505",
  };

  const maxMentions = Math.max(...themes.map(t=>t.mention_count||0), 1);

  // Filter + sort comments
  const filteredComments = topComments
    .filter(c => commentFilter === "all" || c.platform === commentFilter)
    .sort((a,b) => {
      if(commentSort === "freq") return (b.frequency_signal||0) - (a.frequency_signal||0);
      if(commentSort === "neg") return (a.sentiment==="negative"?-1:1);
      if(commentSort === "pos") return (a.sentiment==="positive"?-1:1);
      return 0;
    });

  const platformCounts = summary.platform_counts || {};
  const totalSignals = summary.total_signals || Object.values(platformCounts).reduce((a,b)=>a+b,0);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"28px"}}>

      {/* Key finding banner */}
      {summary.key_finding && (
        <div style={{background:"rgba(200,75,47,0.08)",border:"1px solid rgba(200,75,47,0.25)",borderRadius:"8px",padding:"16px 20px",display:"flex",gap:"14px",alignItems:"flex-start"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.accent,letterSpacing:"0.15em",flexShrink:0,paddingTop:"2px"}}>KEY FINDING</span>
          <span style={{fontSize:"14px",color:T.ink,lineHeight:"1.5",fontStyle:"italic"}}>{summary.key_finding}</span>
        </div>
      )}

      {/* Stat cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:"10px"}}>
        {[
          {label:"Total signals", value:totalSignals},
          {label:"Platforms scraped", value:Object.keys(platformCounts).filter(k=>platformCounts[k]>0).length},
          {label:"Pain themes found", value:themes.length},
          {label:"Whitespace angles", value:themes.filter(t=>(t.whitespace_score||0)>=7).length},
        ].map((s,i)=>(
          <div key={i} style={{background:"rgba(255,255,255,0.03)",border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"14px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,marginBottom:"6px",letterSpacing:"0.1em"}}>{s.label.toUpperCase()}</div>
            <div style={{fontSize:"26px",fontWeight:"500",color:T.ink,fontFamily:"'DM Sans',sans-serif"}}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Main grid: signal strength + competitor matrix */}
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.3fr) minmax(0,1fr)",gap:"16px"}}>

        {/* Signal strength bars */}
        <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.12em",marginBottom:"16px"}}>CROSS-PLATFORM SIGNAL STRENGTH</div>
          <div style={{display:"flex",flexDirection:"column",gap:"12px"}}>
            {themes.map((theme,i)=>{
              const pct = Math.round((theme.mention_count||0)/maxMentions*100);
              const barColor = (theme.whitespace_score||0)>=8?"#c84b2f":(theme.whitespace_score||0)>=5?"rgba(255,180,50,0.8)":"rgba(76,175,80,0.8)";
              const isActive = activeTheme===i;
              return (
                <div key={i} onClick={()=>setActiveTheme(i)} style={{cursor:"pointer",padding:"10px 12px",borderRadius:"6px",background:isActive?"rgba(200,75,47,0.06)":"transparent",border:"1px solid "+(isActive?"rgba(200,75,47,0.2)":"transparent"),transition:"all 0.2s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
                    <span style={{fontSize:"12px",color:T.ink,fontWeight:isActive?"500":"400"}}>{theme.theme}</span>
                    <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>{theme.platform_count||0} platforms</span>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"2px 6px",borderRadius:"3px",background:(theme.whitespace_score||0)>=8?"rgba(200,75,47,0.15)":(theme.whitespace_score||0)>=5?"rgba(255,180,50,0.1)":"rgba(76,175,80,0.1)",color:(theme.whitespace_score||0)>=8?T.accent:(theme.whitespace_score||0)>=5?T.warn:T.green}}>
                        gap {theme.whitespace_score||0}/10
                      </span>
                    </div>
                  </div>
                  <div style={{height:"5px",background:"rgba(255,255,255,0.06)",borderRadius:"3px",overflow:"hidden"}}>
                    <div style={{height:"100%",width:pct+"%",background:barColor,borderRadius:"3px",transition:"width 0.6s ease"}}/>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",gap:"14px",marginTop:"14px"}}>
            {[["gap 8-10","rgba(200,75,47,0.7)","Whitespace"],["gap 5-7","rgba(255,180,50,0.7)","Partial"],["gap 0-4","rgba(76,175,80,0.7)","Covered"]].map(([label,color,desc])=>(
              <span key={label} style={{display:"flex",alignItems:"center",gap:"5px",fontSize:"10px",color:T.muted,fontFamily:"'DM Mono',monospace"}}>
                <span style={{width:"8px",height:"8px",borderRadius:"2px",background:color,display:"inline-block"}}/>
                {desc}
              </span>
            ))}
          </div>
        </div>

        {/* Competitor gap matrix */}
        <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.12em",marginBottom:"16px"}}>COMPETITOR GAP MATRIX</div>
          {competitors.length === 0 ? (
            <div style={{fontSize:"12px",color:T.muted,lineHeight:"1.6"}}>Competitor names auto-extracted from Amazon URLs. Add at least 2 competitor product URLs in Step 1 to see the full matrix.</div>
          ) : (
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                <thead>
                  <tr>
                    <th style={{textAlign:"left",padding:"6px 8px",fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,fontWeight:"normal",borderBottom:"1px solid "+T.rule}}>Pain theme</th>
                    {competitors.slice(0,3).map((c,i)=>(
                      <th key={i} style={{textAlign:"center",padding:"6px 8px",fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,fontWeight:"normal",borderBottom:"1px solid "+T.rule,maxWidth:"80px"}}>{c.slice(0,12)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {themes.slice(0,6).map((theme,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                      <td style={{padding:"8px 8px",color:T.ink,fontSize:"11px",lineHeight:"1.3"}}>{theme.theme}</td>
                      {competitors.slice(0,3).map((comp,j)=>{
                        const coverage = theme.competitor_coverage?.[comp] || "none";
                        const dot = coverage==="addressed"?"✓":coverage==="partial"?"~":"✗";
                        const color = coverage==="addressed"?T.green:coverage==="partial"?T.warn:"rgba(255,100,80,0.7)";
                        const bg = coverage==="addressed"?"rgba(76,175,80,0.08)":coverage==="partial"?"rgba(255,180,50,0.06)":"rgba(255,100,80,0.06)";
                        return (
                          <td key={j} style={{textAlign:"center",padding:"8px"}}>
                            <span style={{display:"inline-block",width:"28px",height:"20px",lineHeight:"20px",borderRadius:"3px",background:bg,color,fontSize:"11px",fontFamily:"'DM Mono',monospace"}}>{dot}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{display:"flex",gap:"12px",marginTop:"12px"}}>
                {[["✓",T.green,"Addressed"],["~",T.warn,"Partial"],["✗","rgba(255,100,80,0.7)","Gap = your angle"]].map(([dot,color,label])=>(
                  <span key={label} style={{fontSize:"10px",color:T.muted,fontFamily:"'DM Mono',monospace",display:"flex",alignItems:"center",gap:"5px"}}>
                    <span style={{color}}>{dot}</span>{label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Whitespace angle detail — selected theme */}
      {themes[activeTheme] && (
        <div style={{background:"rgba(200,75,47,0.04)",border:"1px solid rgba(200,75,47,0.2)",borderRadius:"8px",padding:"20px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"16px"}}>
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.accent,letterSpacing:"0.15em",marginBottom:"6px"}}>WHITESPACE ANGLE — {themes[activeTheme].theme?.toUpperCase()}</div>
              <div style={{fontSize:"12px",color:T.muted,lineHeight:"1.5"}}>{themes[activeTheme].full_description}</div>
            </div>
            <div style={{display:"flex",gap:"6px",flexShrink:0,marginLeft:"16px"}}>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",padding:"3px 10px",borderRadius:"3px",background:"rgba(200,75,47,0.15)",color:T.accent}}>gap score {themes[activeTheme].whitespace_score}/10</span>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",padding:"3px 10px",borderRadius:"3px",background:"rgba(255,255,255,0.05)",color:T.muted}}>{themes[activeTheme].mention_count} mentions</span>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:"12px",marginBottom:"16px"}}>
            <div style={{background:"rgba(0,0,0,0.2)",borderRadius:"6px",padding:"14px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.accent,letterSpacing:"0.12em",marginBottom:"8px"}}>HOOK — USE VERBATIM</div>
              <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.5",fontStyle:"italic"}}>"{themes[activeTheme].whitespace_angle?.hook}"</div>
            </div>
            <div style={{background:"rgba(0,0,0,0.2)",borderRadius:"6px",padding:"14px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.blue,letterSpacing:"0.12em",marginBottom:"8px"}}>STATIC HEADLINE</div>
              <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.5"}}>{themes[activeTheme].whitespace_angle?.static_headline}</div>
            </div>
            <div style={{background:"rgba(0,0,0,0.2)",borderRadius:"6px",padding:"14px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.green,letterSpacing:"0.12em",marginBottom:"8px"}}>CREATOR DIRECTION</div>
              <div style={{fontSize:"12px",color:T.ink,lineHeight:"1.5"}}>{themes[activeTheme].whitespace_angle?.creator_direction}</div>
            </div>
          </div>

          {themes[activeTheme].verbatim_quotes?.length > 0 && (
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,letterSpacing:"0.12em",marginBottom:"8px"}}>VERBATIM FROM REVIEWS — USE THESE EXACT WORDS IN CREATIVE</div>
              <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
                {themes[activeTheme].verbatim_quotes.map((q,i)=>(
                  <div key={i} style={{fontSize:"12px",color:T.muted,fontStyle:"italic",padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:"4px",borderLeft:"2px solid rgba(200,75,47,0.3)"}}>"{q}"</div>
                ))}
              </div>
            </div>
          )}

          <div style={{marginTop:"12px",fontSize:"11px",color:"rgba(200,75,47,0.6)",fontFamily:"'DM Mono',monospace"}}>
            Found on: {themes[activeTheme].platforms?.join(", ")} · {themes[activeTheme].whitespace_angle?.why_this_works}
          </div>
        </div>
      )}

      {/* Platform sentiment */}
      <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.12em",marginBottom:"16px"}}>SENTIMENT BY PLATFORM</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"12px"}}>
          {Object.entries(platformCounts).filter(([,v])=>v>0).map(([platform,count])=>(
            <div key={platform} style={{background:"rgba(255,255,255,0.02)",borderRadius:"6px",padding:"12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
                <span style={{fontSize:"12px",color:T.ink,textTransform:"capitalize"}}>{platform}</span>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted}}>{count} signals</span>
              </div>
              <div style={{height:"6px",borderRadius:"3px",overflow:"hidden",display:"flex",gap:"1px"}}>
                <div style={{flex:3,background:"rgba(255,100,80,0.7)",borderRadius:"3px 0 0 3px"}}/>
                <div style={{flex:1,background:"rgba(255,180,50,0.5)"}}/>
                <div style={{flex:platform==="amazon"||platform==="myntra"?4:2,background:"rgba(76,175,80,0.7)",borderRadius:"0 3px 3px 0"}}/>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Top comments feed */}
      <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"14px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.12em"}}>TOP SCRAPED SIGNALS</div>
          <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
            <select value={commentSort} onChange={e=>setCommentSort(e.target.value)} style={{background:T.card,border:"1px solid "+T.cardBorder,color:T.muted,padding:"4px 8px",borderRadius:"4px",fontSize:"11px",fontFamily:"'DM Mono',monospace"}}>
              <option value="freq">By frequency</option>
              <option value="neg">Most negative</option>
              <option value="pos">Most positive</option>
            </select>
          </div>
        </div>
        <div style={{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"14px"}}>
          {["all","amazon","flipkart","myntra","reddit","tiktok","youtube","instagram"].map(p=>(
            <button key={p} onClick={()=>setCommentFilter(p)}
              style={{padding:"4px 12px",borderRadius:"4px",border:"1px solid "+(commentFilter===p?"rgba(200,75,47,0.4)":T.cardBorder),background:commentFilter===p?"rgba(200,75,47,0.1)":"transparent",color:commentFilter===p?T.accent:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"10px",cursor:"pointer",textTransform:"capitalize"}}>
              {p}
            </button>
          ))}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
          {filteredComments.slice(0,10).map((c,i)=>{
            const sentColor = c.sentiment==="positive"?T.green:c.sentiment==="negative"?"rgba(255,100,80,0.8)":"rgba(255,255,255,0.3)";
            const platColor = PLATFORM_COLORS[c.platform] || T.muted;
            return (
              <div key={i} style={{background:"rgba(255,255,255,0.02)",borderRadius:"6px",padding:"10px 14px",borderLeft:"3px solid "+sentColor}}>
                <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"2px 8px",borderRadius:"3px",background:"rgba(255,255,255,0.05)",color:platColor,textTransform:"capitalize"}}>{c.platform}</span>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:sentColor}}>{c.sentiment}</span>
                  {c.pain_theme&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>→ {c.pain_theme}</span>}
                  <span style={{marginLeft:"auto",fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>signal {c.frequency_signal}/10</span>
                </div>
                <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.5",fontStyle:"italic"}}>"{c.text}"</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* TikTok hashtag volume */}
      {hashtags.length > 0 && (
        <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.12em",marginBottom:"16px"}}>TIKTOK HASHTAG VOLUME</div>
          <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
            {hashtags.map((tag,i)=>{
              const maxIdx = 0;
              const pct = i===0?100:Math.max(20,100-(i*15));
              return (
                <div key={i}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:"12px",marginBottom:"4px"}}>
                    <span style={{color:T.ink,fontFamily:"'DM Mono',monospace"}}>#{tag.hashtag}</span>
                    <span style={{color:T.muted}}>{tag.estimated_reach}</span>
                  </div>
                  <div style={{height:"5px",background:"rgba(255,255,255,0.06)",borderRadius:"3px",overflow:"hidden"}}>
                    <div style={{height:"100%",width:pct+"%",background:"rgba(105,201,208,0.6)",borderRadius:"3px"}}/>
                  </div>
                  {tag.relevance&&<div style={{fontSize:"10px",color:T.muted,marginTop:"3px",fontFamily:"'DM Mono',monospace"}}>{tag.relevance}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Global whitespace */}
      {data.global_whitespace && (
        <div style={{background:"rgba(76,175,80,0.06)",border:"1px solid rgba(76,175,80,0.2)",borderRadius:"8px",padding:"16px 20px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.green,letterSpacing:"0.15em",marginBottom:"8px"}}>BIGGEST WHITESPACE — OWN THIS FIRST</div>
          <div style={{fontSize:"14px",color:T.ink,lineHeight:"1.6"}}>{data.global_whitespace}</div>
        </div>
      )}
    </div>
  );
}

// ─── ICP OUTPUT TABS ─────────────────────────────────────────

const ICP_TABS = [
  {key:"strategy",   label:"Strategy"},
  {key:"proven",     label:"Proven Formula"},
  {key:"creative",   label:"Creative"},
  {key:"scripts",    label:"Scripts"},
  {key:"kits",       label:"Creator & Designer Kits"},
  {key:"performance",label:"Performance"},
  {key:"generate",   label:"Generate Creative ✦"},
];

function ICPOutput({icp, brand, product, visualIntel}) {
  const [tab, setTab] = useState("strategy");
  const [genState, setGenState] = useState("idle"); // idle | loading | done | error
  const [genResult, setGenResult] = useState(null);
  const [genError, setGenError] = useState("");

  const handleGenerate = async () => {
    setGenState("loading");
    setGenError("");
    const topPattern = visualIntel?.top_patterns?.[0] || {};
    const usp = (icp.usp_bridge||[])[0]?.product_usp || "";
    try {
      const res = await fetch("/api/generate-creative", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ icp, visualPattern: topPattern, brand, product, usp }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGenResult(data);
      setGenState("done");
    } catch(e) {
      setGenError(e.message);
      setGenState("error");
    }
  };

  if (!icp) return null;
  const p = icp.profile||{};
  const pr = icp.problem||{};
  const cr = icp.creative||{};
  const perf = icp.performance||{};

  return (
    <div>
      <div style={{background:"rgba(200,75,47,0.06)",border:"1px solid rgba(200,75,47,0.2)",borderRadius:"8px",padding:"20px 24px",marginBottom:"24px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"12px"}}>
          <div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:"24px",fontWeight:"700",color:T.ink,marginBottom:"4px"}}>{p.name||"ICP "+icp.id}</div>
            <div style={{fontSize:"13px",color:T.muted}}>{p.age_range} · {p.city_tier} · {p.income_bracket}</div>
          </div>
          <span style={{padding:"4px 14px",borderRadius:"2px",fontFamily:"'DM Mono',monospace",fontSize:"10px",background:icp.type==="PRIMARY"?T.accent:"rgba(255,255,255,0.1)",color:icp.type==="PRIMARY"?T.ink:T.muted,flexShrink:0}}>{icp.type}</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"12px",marginTop:"12px"}}>
          <div><Label>Purchase Trigger</Label><div style={{fontSize:"12px",color:T.ink,lineHeight:"1.5"}}>{p.purchase_trigger}</div></div>
          <div><Label>Purchase Blocker</Label><div style={{fontSize:"12px",color:T.ink,lineHeight:"1.5"}}>{p.purchase_blocker}</div></div>
          <div><Label>Where They Hang</Label><div style={{fontSize:"12px",color:T.ink,lineHeight:"1.5"}}>{p.where_they_spend_time?.join(", ")}</div></div>
        </div>
      </div>

      <div style={{display:"flex",gap:"4px",marginBottom:"24px",borderBottom:"1px solid "+T.rule,overflowX:"auto"}}>
        {ICP_TABS.map(({key,label})=>(
          <button key={key} onClick={()=>setTab(key)}
            style={{background:"none",border:"none",borderBottom:"2px solid "+(tab===key?T.accent:"transparent"),color:tab===key?T.ink:T.muted,padding:"10px 16px",cursor:"pointer",fontSize:"12px",fontFamily:"'DM Mono',monospace",letterSpacing:"0.05em",whiteSpace:"nowrap",marginBottom:"-1px"}}>
            {label}
          </button>
        ))}
      </div>

      {tab==="strategy"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="Core Problem — Consumer Language" accent>
            <div style={{background:"rgba(200,75,47,0.08)",border:"1px solid rgba(200,75,47,0.2)",borderRadius:"6px",padding:"20px"}}>
              <div style={{fontSize:"16px",fontStyle:"italic",lineHeight:"1.7",marginBottom:"12px",color:T.ink}}>"{pr.core_problem}"</div>
              <div style={{fontSize:"12px",color:T.muted,marginBottom:"12px"}}>{pr.problem_depth}</div>
              <div style={{display:"flex",gap:"24px",marginBottom:"12px"}}>
                <div><Label color={T.red}>Emotion Before</Label><div style={{fontSize:"12px",color:T.ink}}>{pr.emotion_before_purchase}</div></div>
                <div><Label color={T.green}>Emotion After</Label><div style={{fontSize:"12px",color:T.ink}}>{pr.emotion_after_purchase}</div></div>
              </div>
              {pr.real_quotes?.length>0&&(
                <div style={{borderTop:"1px solid "+T.rule,paddingTop:"12px"}}>
                  <Label>Real Quotes From Reviews</Label>
                  {pr.real_quotes.map((q,i)=><div key={i} style={{fontSize:"12px",color:T.muted,fontStyle:"italic",marginBottom:"4px"}}>"{q}"</div>)}
                </div>
              )}
              {pr.data_attribution?.length>0&&(
                <div style={{borderTop:"1px solid "+T.rule,paddingTop:"10px",marginTop:"8px"}}>
                  <Label>Data Attribution</Label>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"6px"}}>
                    {pr.data_attribution.map((d,i)=><Tag key={i} color="muted">{d}</Tag>)}
                  </div>
                </div>
              )}
            </div>
          </Section>

          <Section title="Problem → USP Bridge">
            <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
              {(icp.usp_bridge||[]).map((item,i)=>(
                <div key={i} style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",borderBottom:"1px solid "+T.cardBorder}}>
                    <div style={{padding:"12px 14px",borderRight:"1px solid "+T.cardBorder}}>
                      <Label color={T.red}>Consumer Problem</Label>
                      <div style={{fontSize:"12px",lineHeight:"1.5",color:T.ink}}>{item.consumer_problem}</div>
                    </div>
                    <div style={{padding:"12px 14px",borderRight:"1px solid "+T.cardBorder}}>
                      <Label color={T.green}>Product USP</Label>
                      <div style={{fontSize:"12px",lineHeight:"1.5",color:T.ink,fontWeight:"600"}}>{item.product_usp}</div>
                    </div>
                    <div style={{padding:"12px 14px"}}>
                      <Label color={T.blue}>Proof Point</Label>
                      <div style={{fontSize:"12px",lineHeight:"1.5",color:T.ink}}>{item.proof_point}</div>
                    </div>
                  </div>
                  <div style={{padding:"10px 14px",background:"rgba(200,75,47,0.04)"}}>
                    <Label color={T.accent}>Creative Angle</Label>
                    <div style={{fontSize:"12px",color:T.ink,fontStyle:"italic"}}>{item.creative_angle}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Objection Map">
            <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
              {(icp.objection_map||[]).map((item,i)=>(
                <Card key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"12px"}}>
                  <div><Label color={T.red}>Objection</Label><div style={{fontSize:"12px",color:T.ink}}>{item.objection}</div></div>
                  <div><Label color={T.green}>Counter</Label><div style={{fontSize:"12px",color:T.ink}}>{item.counter}</div></div>
                  <div><Label color={T.accent}>Ad Line</Label><div style={{fontSize:"12px",color:T.ink,fontStyle:"italic"}}>"{item.ad_line}"</div></div>
                </Card>
              ))}
            </div>
          </Section>

          <Section title="Concept Recommendations">
            <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
              {(icp.concepts||[]).map((item,i)=>(
                <Card key={i} style={{display:"grid",gridTemplateColumns:"120px 80px 1fr 1fr",gap:"12px",alignItems:"start"}}>
                  <div><Label>Concept</Label><div style={{fontSize:"13px",fontWeight:"600",color:T.ink}}>{item.concept}</div></div>
                  <div><Label>Format</Label><Tag color="accent">{item.format}</Tag></div>
                  <div><Label>Rationale</Label><div style={{fontSize:"12px",color:T.muted}}>{item.rationale}</div></div>
                  <div><Label>Data Source</Label><div style={{fontSize:"11px",color:T.muted,fontStyle:"italic"}}>{item.data_source}</div></div>
                </Card>
              ))}
            </div>
          </Section>
        </div>
      )}


      {tab==="proven"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="Proven Formula — Windsor AI Data" accent>
            {icp.proven_formula ? (
              <div style={{background:"rgba(76,175,80,0.06)",border:"1px solid rgba(76,175,80,0.2)",borderRadius:"8px",padding:"24px"}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"20px",marginBottom:"20px"}}>
                  <div>
                    <Label color={T.green}>Winning Angle</Label>
                    <div style={{fontSize:"16px",color:T.ink,fontWeight:"500",lineHeight:"1.4"}}>{icp.proven_formula.winning_angle||"—"}</div>
                  </div>
                  <div style={{display:"flex",gap:"16px"}}>
                    <div>
                      <Label>ROAS</Label>
                      <div style={{fontSize:"26px",fontWeight:"500",color:icp.proven_formula.roas&&icp.proven_formula.roas!=="Not yet tested"?T.green:T.muted}}>{icp.proven_formula.roas||"—"}</div>
                    </div>
                    <div><Label>Format</Label><div style={{fontSize:"16px",color:T.ink,marginTop:"4px"}}>{icp.proven_formula.format||"—"}</div></div>
                  </div>
                </div>
                <div style={{borderTop:"1px solid rgba(76,175,80,0.15)",paddingTop:"16px",display:"flex",flexDirection:"column",gap:"12px"}}>
                  <div><Label color={T.green}>Why it works for this ICP</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{icp.proven_formula.why_it_works||"—"}</div></div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px"}}>
                    <div style={{background:"rgba(76,175,80,0.06)",borderRadius:"6px",padding:"14px",border:"1px solid rgba(76,175,80,0.15)"}}>
                      <Label color={T.green}>Do this</Label>
                      <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{icp.proven_formula.do_this||"—"}</div>
                    </div>
                    <div style={{background:"rgba(255,100,80,0.04)",borderRadius:"6px",padding:"14px",border:"1px solid rgba(255,100,80,0.12)"}}>
                      <Label color={T.red}>Don't do this</Label>
                      <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{icp.proven_formula.dont_do_this||"—"}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{padding:"24px",textAlign:"center",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"12px"}}>Add Windsor API key in Step 1 to enable Proven Formula.</div>
            )}
          </Section>
        </div>
      )}

      {tab==="creative"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="5 Hook Variations — Ready to Test" accent>
            <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
              {(cr.hooks||[]).map((h,i)=>(
                <Card key={i} style={{display:"grid",gridTemplateColumns:"40px 1fr 120px",gap:"12px",alignItems:"start"}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:"18px",color:T.accent,fontWeight:"700"}}>H{i+1}</div>
                  <div>
                    <div style={{fontSize:"15px",color:T.ink,lineHeight:"1.5",marginBottom:"6px",fontWeight:"500"}}>"{h.hook}"</div>
                    <div style={{fontSize:"11px",color:T.muted}}>{h.why_it_works}</div>
                  </div>
                  <Tag color="muted">{h.type}</Tag>
                </Card>
              ))}
            </div>
          </Section>

          <Section title="Static Ad Copy — Ready to Paste">
            <Card>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px"}}>
                <div style={{gridColumn:"1/-1"}}>
                  <Label>Headline</Label>
                  <div style={{fontFamily:"'Playfair Display',serif",fontSize:"22px",fontWeight:"700",color:T.ink,lineHeight:"1.4"}}>{cr.static_ad?.headline}</div>
                </div>
                <div>
                  <Label>Body Copy</Label>
                  <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.7"}}>{cr.static_ad?.body_copy}</div>
                </div>
                <div>
                  <Label>USP Line</Label>
                  <div style={{fontSize:"13px",color:T.ink,marginBottom:"12px"}}>{cr.static_ad?.usp_line}</div>
                  <div style={{background:T.accent,borderRadius:"4px",padding:"10px 16px",display:"inline-block",fontSize:"13px",fontWeight:"600",color:T.ink}}>{cr.static_ad?.cta}</div>
                </div>
              </div>
            </Card>
          </Section>

          <Section title="Body Copy Variations">
            <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
              {(cr.body_copy_variations||[]).map((v,i)=>(
                <Card key={i}>
                  <Label color={T.accent}>{v.angle}</Label>
                  <div style={{fontSize:"13px",color:T.ink,lineHeight:"1.7"}}>{v.copy}</div>
                </Card>
              ))}
            </div>
          </Section>
        </div>
      )}

      {tab==="scripts"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="Full Video Script — Verbatim" accent>
            <div style={{background:"rgba(200,75,47,0.04)",border:"1px solid rgba(200,75,47,0.2)",borderRadius:"6px",padding:"20px"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:"16px"}}>
                <div><Label>Duration</Label><div style={{fontSize:"13px",color:T.ink}}>{cr.video_script?.duration}</div></div>
                <div style={{textAlign:"right"}}><Label>Creator Direction</Label><div style={{fontSize:"12px",color:T.muted,maxWidth:"300px",textAlign:"right"}}>{cr.video_script?.creator_direction}</div></div>
              </div>
              <div style={{background:T.bg,borderRadius:"4px",padding:"14px",marginBottom:"16px",border:"1px solid "+T.cardBorder}}>
                <Label color={T.accent}>HOOK</Label>
                <div style={{fontSize:"16px",color:T.ink,fontWeight:"600"}}>"{cr.video_script?.hook_line}"</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
                {(cr.video_script?.body||[]).map((beat,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr",gap:"10px",background:T.card,borderRadius:"4px",padding:"10px 12px",border:"1px solid "+T.cardBorder}}>
                    <div><Label>Time</Label><div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.accent}}>{beat.timestamp}</div></div>
                    <div><Label>Action</Label><div style={{fontSize:"12px",color:T.muted}}>{beat.action}</div></div>
                    <div><Label>Dialogue + Delivery</Label><div style={{fontSize:"12px",color:T.ink}}>"{beat.dialogue}"</div><div style={{fontSize:"10px",color:T.muted,marginTop:"3px",fontStyle:"italic"}}>{beat.delivery_note}</div></div>
                  </div>
                ))}
              </div>
              <div style={{background:T.bg,borderRadius:"4px",padding:"14px",marginTop:"12px",border:"1px solid "+T.cardBorder}}>
                <Label color={T.green}>CTA</Label>
                <div style={{fontSize:"15px",color:T.ink,fontWeight:"600"}}>{cr.video_script?.cta}</div>
              </div>
            </div>
          </Section>

          <Section title="Shot List">
            <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
              {(cr.shot_list||[]).map((shot,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"40px 100px 1fr 180px 60px",gap:"10px",alignItems:"start",background:T.card,borderRadius:"4px",padding:"10px 12px",border:"1px solid "+T.cardBorder}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:"12px",color:T.accent,fontWeight:"600"}}>#{shot.shot_number}</div>
                  <div><Label>Shot Type</Label><div style={{fontSize:"11px",color:T.muted}}>{shot.shot_type}</div></div>
                  <div><Label>Action</Label><div style={{fontSize:"12px",color:T.ink}}>{shot.action}</div></div>
                  <div><Label>Text Overlay</Label><div style={{fontSize:"11px",color:T.ink,fontWeight:"500"}}>"{shot.text_overlay}"</div></div>
                  <div><Label>Duration</Label><div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>{shot.duration}</div></div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      {tab==="kits"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="UGC Creator Brief" accent>
            <Card>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"20px"}}>
                <div style={{gridColumn:"1/-1"}}>
                  <Label color={T.accent}>Opening Hook</Label>
                  <div style={{fontSize:"16px",color:T.ink,fontWeight:"600",lineHeight:"1.5"}}>"{cr.ugc_creator_brief?.hook}"</div>
                </div>
                <div><Label>Key Message</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{cr.ugc_creator_brief?.key_message}</div></div>
                <div><Label>Vibe & Energy</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{cr.ugc_creator_brief?.vibe}</div></div>
                <div>
                  <Label color={T.green}>Must Show</Label>
                  {(cr.ugc_creator_brief?.must_show||[]).map((s,i)=><div key={i} style={{fontSize:"12px",color:T.ink,marginBottom:"3px"}}>✓ {s}</div>)}
                </div>
                <div>
                  <Label color={T.green}>Must Say</Label>
                  {(cr.ugc_creator_brief?.must_say||[]).map((s,i)=><div key={i} style={{fontSize:"12px",color:T.ink,marginBottom:"3px",fontStyle:"italic"}}>"{s}"</div>)}
                </div>
                <div style={{gridColumn:"1/-1"}}>
                  <Label color={T.red}>Must NOT Say</Label>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"6px"}}>
                    {(cr.ugc_creator_brief?.must_not_say||[]).map((s,i)=><Tag key={i} color="muted">✕ {s}</Tag>)}
                  </div>
                </div>
                <div style={{gridColumn:"1/-1"}}>
                  <Label>Outfit / Props</Label>
                  <div style={{fontSize:"13px",color:T.ink}}>{cr.ugc_creator_brief?.outfit_props}</div>
                </div>
              </div>
            </Card>
          </Section>

          <Section title="Designer Brief">
            <Card>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"20px"}}>
                <div><Label>Visual Style</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{cr.designer_brief?.visual_style}</div></div>
                <div><Label>Colour Direction</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{cr.designer_brief?.colour_direction}</div></div>
                <div><Label>Typography Feel</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{cr.designer_brief?.typography_feel}</div></div>
                <div><Label>Text Overlay Style</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.6"}}>{cr.designer_brief?.text_overlay_style}</div></div>
                <div>
                  <Label>Mood Board Keywords</Label>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"6px",marginTop:"4px"}}>
                    {(cr.designer_brief?.mood_board_keywords||[]).map((k,i)=><Tag key={i} color="blue">{k}</Tag>)}
                  </div>
                </div>
                <div>
                  <Label color={T.red}>What to Avoid</Label>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"6px",marginTop:"4px"}}>
                    {(cr.designer_brief?.what_to_avoid||[]).map((k,i)=><Tag key={i} color="muted">✕ {k}</Tag>)}
                  </div>
                </div>
              </div>
            </Card>
          </Section>
        </div>
      )}

      {tab==="performance"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="Performance Plan" accent>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
              <Card><Label>Budget Split Suggestion</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.7"}}>{perf.budget_split_suggestion}</div></Card>
              <Card><Label>Primary Placement</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.7"}}>{perf.primary_placement}</div></Card>
              <Card style={{gridColumn:"1/-1"}}><Label>Testing Order</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.7"}}>{perf.testing_order}</div></Card>
              <Card style={{gridColumn:"1/-1"}}><Label color={T.green}>Success Looks Like</Label><div style={{fontSize:"13px",color:T.ink,lineHeight:"1.7"}}>{perf.success_looks_like}</div></Card>
              <Card style={{gridColumn:"1/-1"}}>
                <Label>KPIs to Track</Label>
                <div style={{display:"flex",flexWrap:"wrap",gap:"6px",marginTop:"4px"}}>
                  {(perf.kpis||[]).map((k,i)=><Tag key={i} color="green">{k}</Tag>)}
                </div>
              </Card>
              <Card style={{gridColumn:"1/-1"}}>
                <Label>Recommended Formats</Label>
                <div style={{display:"flex",flexWrap:"wrap",gap:"6px",marginTop:"4px"}}>
                  {(perf.recommended_formats||[]).map((f,i)=><Tag key={i} color="accent">{f}</Tag>)}
                </div>
              </Card>
            </div>
          </Section>
        </div>
      )}

      {tab==="generate"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
          <Section title="AI Creative Generation — DALL-E 3" accent>
            <div style={{background:"rgba(200,75,47,0.04)",border:"1px solid rgba(200,75,47,0.15)",borderRadius:"8px",padding:"20px",marginBottom:"16px"}}>
              <div style={{fontSize:"13px",color:T.muted,lineHeight:"1.7",marginBottom:"16px"}}>
                GPT-4o synthesises the winning visual pattern from your top ROAS ads with this ICP's core problem and angle, then DALL-E 3 generates a photorealistic Indian lifestyle ad image ready to hand to your design team.
              </div>
              <div style={{display:"flex",gap:"12px",flexWrap:"wrap",marginBottom:"16px"}}>
                {visualIntel?.top_patterns?.[0] && Object.entries(visualIntel.top_patterns[0]).map(([k,v])=>(
                  <div key={k} style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"4px",padding:"4px 10px"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,textTransform:"uppercase"}}>{k.replace(/_/g," ")}: </span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.ink}}>{v}</span>
                  </div>
                ))}
                {!visualIntel?.top_patterns?.[0]&&<div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>Upload creative sheet + Windsor key to enable visual pattern data.</div>}
              </div>
              {genState==="idle"&&(
                <button onClick={handleGenerate} style={{background:T.accent,color:T.ink,border:"none",borderRadius:"6px",padding:"12px 28px",fontSize:"14px",fontWeight:"600",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                  Generate Ad with DALL-E 3 →
                </button>
              )}
              {genState==="loading"&&(
                <div style={{display:"flex",alignItems:"center",gap:"12px",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"12px"}}>
                  <div style={{width:"16px",height:"16px",border:"2px solid rgba(200,75,47,0.3)",borderTop:"2px solid "+T.accent,borderRadius:"50%",animation:"spin 1s linear infinite",flexShrink:0}}/>
                  GPT-4o writing prompt → DALL-E 3 generating image… (30–60s)
                </div>
              )}
              {genState==="error"&&(
                <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
                  <div style={{color:"rgba(255,100,80,0.9)",fontSize:"13px"}}>✗ {genError}</div>
                  <button onClick={handleGenerate} style={{background:"rgba(200,75,47,0.15)",color:T.accent,border:"1px solid rgba(200,75,47,0.4)",borderRadius:"6px",padding:"8px 20px",fontSize:"13px",cursor:"pointer",fontFamily:"'DM Mono',monospace",width:"fit-content"}}>Retry →</button>
                </div>
              )}
            </div>

            {genState==="done"&&genResult&&(
              <div style={{display:"flex",flexDirection:"column",gap:"16px"}}>
                <img src={genResult.imageUrl} alt="Generated ad creative" style={{width:"100%",maxWidth:"600px",borderRadius:"8px",border:"1px solid "+T.cardBorder,display:"block"}}/>
                <div style={{display:"flex",gap:"10px"}}>
                  <a href={genResult.imageUrl} download target="_blank" rel="noreferrer" style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",padding:"6px 16px",borderRadius:"4px",cursor:"pointer",background:"rgba(76,175,80,0.1)",color:T.green,border:"1px solid rgba(76,175,80,0.3)",textDecoration:"none"}}>↓ Download Image</a>
                  <button onClick={handleGenerate} style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",padding:"6px 16px",borderRadius:"4px",cursor:"pointer",background:T.card,color:T.muted,border:"1px solid "+T.cardBorder}}>Regenerate</button>
                </div>
                <details style={{marginTop:"8px"}}>
                  <summary style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,cursor:"pointer",letterSpacing:"0.1em"}}>VIEW DALL-E PROMPT</summary>
                  <div style={{marginTop:"8px",background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"14px",fontSize:"12px",color:T.muted,lineHeight:"1.7",fontStyle:"italic"}}>{genResult.dallePrompt}</div>
                </details>
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}


// ─── WINDSOR PANEL ────────────────────────────────────────────

function WindsorPanel({data}) {
  if (!data) return <div style={{padding:"40px",textAlign:"center",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"12px"}}>No Windsor data — add your Windsor API key in Step 1.</div>;
  const top = data.top_performers||[];
  const fatigued = data.fatigued_angles||[];
  const fmt = data.format_performance||{};
  const fmtKeys = Object.keys(fmt);
  const products = data.product_performance||[];
  const ctypes = data.content_type_performance||[];
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"20px"}}>
      {/* Summary stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:"10px"}}>
        <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"14px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,marginBottom:"6px"}}>ADS ANALYSED</div>
          <div style={{fontSize:"26px",fontWeight:"500",color:T.ink}}>{data.total_ads_analysed}</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"14px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,marginBottom:"6px"}}>SPEND ANALYSED</div>
          <div style={{fontSize:"26px",fontWeight:"500",color:T.ink}}>₹{(data.total_spend_analysed/100000).toFixed(1)}L</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"14px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,marginBottom:"6px"}}>BEST ROAS</div>
          <div style={{fontSize:"26px",fontWeight:"500",color:T.green}}>{data.best_roas}x</div>
        </div>
      </div>

      {/* Format breakdown */}
      {fmtKeys.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat("+Math.min(fmtKeys.length,4)+",minmax(0,1fr))",gap:"10px"}}>
          {fmtKeys.map(k=>(
            <div key={k} style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"12px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,marginBottom:"6px"}}>{k.toUpperCase()}</div>
              <div style={{fontSize:"18px",fontWeight:"500",color:T.ink,marginBottom:"2px"}}>{fmt[k]?.avg_roas||"—"}x</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted}}>{fmt[k]?.count||0} ads · ₹{Math.round((fmt[k]?.total_spend||0)/1000)}K</div>
            </div>
          ))}
        </div>
      )}

      {/* Product + Content type breakdown side by side */}
      {(products.length>0||ctypes.length>0)&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
          {products.length>0&&(
            <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"16px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.1em",marginBottom:"12px"}}>BY PRODUCT</div>
              <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
                {products.slice(0,6).map((p,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 50px 50px",gap:"8px",alignItems:"center",fontSize:"12px"}}>
                    <div style={{color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.product}</div>
                    <div style={{textAlign:"right",color:T.green,fontWeight:"500"}}>{p.avg_roas}x</div>
                    <div style={{textAlign:"right",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"10px"}}>₹{Math.round(p.total_spend/1000)}K</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {ctypes.length>0&&(
            <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"16px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.muted,letterSpacing:"0.1em",marginBottom:"12px"}}>BY CONTENT TYPE</div>
              <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
                {ctypes.map((c,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 50px 50px",gap:"8px",alignItems:"center",fontSize:"12px"}}>
                    <div style={{color:T.ink}}>{c.type}</div>
                    <div style={{textAlign:"right",color:T.green,fontWeight:"500"}}>{c.avg_roas}x</div>
                    <div style={{textAlign:"right",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"10px"}}>{c.count} ads</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top performers */}
      <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.green,letterSpacing:"0.12em",marginBottom:"14px"}}>TOP PERFORMERS — LAST 30 DAYS</div>
        <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
          {top.map((p,i)=>(
            <div key={i} style={{padding:"10px 12px",background:"rgba(76,175,80,0.04)",borderRadius:"6px",border:"1px solid rgba(76,175,80,0.1)"}}>
              <div style={{display:"grid",gridTemplateColumns:"24px 1fr 70px 60px 60px 60px",gap:"10px",alignItems:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.green,fontWeight:"600"}}>#{i+1}</div>
                <div style={{overflow:"hidden"}}>
                  <div style={{fontSize:"11px",color:T.ink,marginBottom:"4px",lineHeight:"1.3",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.creative_name}</div>
                  <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(255,255,255,0.06)",color:T.muted}}>{p.format}</span>
                    {p.product!=="Other"&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(255,255,255,0.04)",color:T.muted}}>{p.product}</span>}
                    {p.contentType!=="Tactical"&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(100,160,255,0.08)",color:T.blue}}>{p.contentType}</span>}
                    {p.creator&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(200,150,255,0.08)",color:"#b39ddb"}}>{p.creator}</span>}
                  </div>
                </div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"15px",fontWeight:"500",color:T.green}}>{p.roas}x</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>ROAS</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"12px",color:T.ink}}>{p.purchases}</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>orders</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"12px",color:T.ink}}>{p.ctr}%</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>CTR</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"12px",color:T.muted}}>₹{(p.spend/1000).toFixed(0)}K</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>spend</div></div>
              </div>
              {(p.hook_rate!=null)&&(
                <div style={{display:"flex",gap:"12px",marginTop:"6px",paddingTop:"6px",borderTop:"1px solid rgba(255,255,255,0.04)"}}>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>HOOK <span style={{color:T.ink}}>{p.hook_rate}%</span></span>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>HOLD <span style={{color:T.ink}}>{p.hold_rate}%</span></span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Fatigued angles */}
      {fatigued.length>0&&(
        <div style={{background:T.card,border:"1px solid rgba(255,100,80,0.15)",borderRadius:"8px",padding:"18px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.red,letterSpacing:"0.12em",marginBottom:"14px"}}>FATIGUED / KILLED ANGLES — DO NOT REPEAT</div>
          <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
            {fatigued.map((f,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 60px 60px 60px",gap:"10px",alignItems:"center",padding:"10px 12px",background:"rgba(255,100,80,0.04)",borderRadius:"6px",border:"1px solid rgba(255,100,80,0.08)"}}>
                <div>
                  <div style={{fontSize:"11px",color:T.muted,lineHeight:"1.3",marginBottom:"3px"}}>{f.creative_name.slice(0,70)}</div>
                  <div style={{display:"flex",gap:"4px"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(255,255,255,0.04)",color:T.muted}}>{f.format}</span>
                    {f.product!=="Other"&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(255,255,255,0.04)",color:T.muted}}>{f.product}</span>}
                  </div>
                </div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"13px",color:"rgba(255,100,80,0.8)"}}>{f.roas}x</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>ROAS</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"12px",color:T.muted}}>₹{(f.spend/1000).toFixed(0)}K</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>burned</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:"11px",color:T.muted}}>{f.contentType}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CREATIVE INTEL PANEL ─────────────────────────────────────

const DIM_LABELS = {
  format: "Format", person_type: "Person Type", text_style: "Text Style", background: "Background",
  hook_type: "Hook Type", color_palette: "Color Palette", composition: "Composition",
};

function CreativeIntelPanel({ data }) {
  const [activeDim, setActiveDim] = useState("hook_type");
  if (!data) return <div style={{padding:"40px",textAlign:"center",color:T.muted,fontFamily:"'DM Mono',monospace",fontSize:"12px"}}>No creative intel — upload the creative sheet in Step 1.</div>;
  const { correlations, top_creatives, total_analysed, avg_roas_all } = data;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
      {/* Summary */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:"10px"}}>
        {[
          {label:"CREATIVES ANALYSED", value:total_analysed},
          {label:"AVG ROAS (joined)", value:avg_roas_all+"x"},
          {label:"VISUAL DIMENSIONS", value:Object.keys(correlations||{}).length},
        ].map(({label,value})=>(
          <div key={label} style={{background:"rgba(255,255,255,0.03)",border:"1px solid "+T.cardBorder,borderRadius:"6px",padding:"14px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted,marginBottom:"6px"}}>{label}</div>
            <div style={{fontSize:"24px",fontWeight:"500",color:"#b39ddb"}}>{value}</div>
          </div>
        ))}
      </div>

      {/* Dimension selector */}
      <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#b39ddb",letterSpacing:"0.12em",marginBottom:"14px"}}>VISUAL PATTERN CORRELATIONS — WHAT DRIVES ROAS</div>
        <div style={{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"18px"}}>
          {Object.keys(correlations||{}).map(dim=>(
            <button key={dim} onClick={()=>setActiveDim(dim)} style={{
              fontFamily:"'DM Mono',monospace",fontSize:"10px",padding:"5px 12px",borderRadius:"20px",cursor:"pointer",
              background:activeDim===dim?"rgba(180,120,255,0.15)":"rgba(255,255,255,0.04)",
              color:activeDim===dim?"#b39ddb":T.muted,
              border:`1px solid ${activeDim===dim?"rgba(180,120,255,0.4)":T.cardBorder}`,
            }}>{DIM_LABELS[dim]||dim}</button>
          ))}
        </div>
        {correlations?.[activeDim]?.length > 0 && (
          <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
            {correlations[activeDim].map((row,i)=>{
              const isTop = row.lift >= 10;
              const isNeg = row.lift < 0;
              return (
                <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 70px 70px 80px 70px",gap:"10px",alignItems:"center",padding:"10px 12px",borderRadius:"6px",background:isTop?"rgba(180,120,255,0.05)":"rgba(255,255,255,0.02)",border:`1px solid ${isTop?"rgba(180,120,255,0.15)":T.cardBorder}`}}>
                  <div style={{fontSize:"13px",color:T.ink,fontWeight:isTop?"500":"400"}}>{row.tag.replace(/_/g," ")}</div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:"16px",fontWeight:"500",color:"#b39ddb"}}>{row.avg_roas}x</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>ROAS</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:"13px",color:isTop?T.green:isNeg?"rgba(255,100,80,0.8)":T.muted,fontWeight:"500"}}>{row.lift>0?"+":""}{row.lift}%</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>vs avg</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:"12px",color:T.muted}}>₹{Math.round(row.total_spend/1000)}K</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>spend</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:"12px",color:T.muted}}>{row.count}</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>ads</div></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Top creative cards */}
      {top_creatives?.length > 0 && (
        <div style={{background:T.card,border:"1px solid "+T.cardBorder,borderRadius:"8px",padding:"18px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#b39ddb",letterSpacing:"0.12em",marginBottom:"14px"}}>TOP 10 ANALYSED CREATIVES</div>
          <div style={{display:"flex",flexDirection:"column",gap:"12px"}}>
            {top_creatives.map((c,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"80px 1fr",gap:"14px",alignItems:"start",padding:"12px",borderRadius:"6px",border:"1px solid "+T.cardBorder,background:"rgba(255,255,255,0.02)"}}>
                {/* Thumbnail */}
                <div style={{width:"80px",height:"80px",borderRadius:"4px",overflow:"hidden",background:"rgba(255,255,255,0.05)",flexShrink:0}}>
                  {c.thumbUrl
                    ? <img src={c.thumbUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none";}}/>
                    : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.muted}}>NO IMG</div>
                  }
                </div>
                <div>
                  <div style={{fontSize:"11px",color:T.ink,marginBottom:"6px",lineHeight:"1.4"}}>{c.adName}</div>
                  <div style={{display:"flex",gap:"6px",marginBottom:"8px",flexWrap:"wrap"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"2px 6px",borderRadius:"3px",background:"rgba(180,120,255,0.12)",color:"#b39ddb"}}>{c.roas}x ROAS</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"2px 6px",borderRadius:"3px",background:"rgba(255,255,255,0.05)",color:T.muted}}>₹{Math.round(c.spend/1000)}K</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"2px 6px",borderRadius:"3px",background:"rgba(255,255,255,0.05)",color:T.muted}}>{c.format}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"2px 6px",borderRadius:"3px",background:"rgba(255,255,255,0.05)",color:T.muted}}>{c.contentType}</span>
                  </div>
                  {/* Visual tags */}
                  {c.visualTags && Object.keys(c.visualTags).length > 0 && (
                    <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
                      {Object.entries(c.visualTags).map(([k,v])=>(
                        <span key={k} style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",padding:"1px 5px",borderRadius:"3px",background:"rgba(180,120,255,0.06)",color:"rgba(179,157,219,0.7)",border:"1px solid rgba(180,120,255,0.15)"}}>
                          {k.replace(/_/g," ")}: {v.replace(/_/g," ")}
                        </span>
                      ))}
                    </div>
                  )}
                  {c.primaryText && <div style={{marginTop:"8px",fontSize:"11px",color:T.muted,lineHeight:"1.5",fontStyle:"italic"}}>"{c.primaryText.slice(0,120)}{c.primaryText.length>120?"...":""}"</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BRIEF OUTPUT ─────────────────────────────────────────────

function BriefOutput({data, researchData, windsorAngles, metaAdsInsights, creativeIntel, onReset}) {
  const [activeTab, setActiveTab] = useState("research");
  const icps = data?.icps || [];

  function exportJSON() {
    const exportData = {
      brand: data.brand,
      product: data.product,
      core_problem: data.core_problem,
      competitor_gap: data.competitor_gap,
      global_ad_insights: data.global_ad_insights,
      icps: data.icps,
      research: researchData,
      windsor_performance: windsorAngles || null,
      meta_ads_insights: metaAdsInsights || null,
      visual_intelligence: creativeIntel || null,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (data.brand || "brief").replace(/\s+/g, "-").toLowerCase() + "-creative-os.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function buildMarkdown() {
    const lines = [];
    const slug = s => s || "—";
    const list = arr => (arr||[]).map(s=>`- ${s}`).join("\n") || "—";

    lines.push(`# Creative Brief — ${slug(data.brand)} / ${slug(data.product)}`);
    lines.push(`_Generated: ${new Date().toLocaleString()}_\n`);
    lines.push(`## Core Problem\n${slug(data.core_problem)}\n`);
    lines.push(`## Competitor Gap\n${slug(data.competitor_gap)}\n`);

    if (data.global_ad_insights) {
      const g = data.global_ad_insights;
      lines.push(`## Global Ad Intelligence`);
      if ((g.angles_to_test||[]).length) lines.push(`**Angles to Test**\n${list(g.angles_to_test)}`);
      if ((g.angles_to_avoid||[]).length) lines.push(`**Angles to Avoid**\n${list(g.angles_to_avoid)}`);
      lines.push("");
    }

    (data.icps||[]).forEach((icp, idx) => {
      const p = icp.profile||{}, pr = icp.problem||{}, cr = icp.creative||{};
      lines.push(`---\n# ICP ${idx+1} — ${slug(p.name)} [${icp.type||""}]`);
      lines.push(`${slug(p.age_range)} · ${slug(p.city_tier)} · ${slug(p.income_bracket)}`);
      lines.push(`**Purchase Trigger:** ${slug(p.purchase_trigger)}`);
      lines.push(`**Purchase Blocker:** ${slug(p.purchase_blocker)}\n`);

      lines.push(`## Core Problem (Consumer Language)`);
      lines.push(`> "${slug(pr.core_problem)}"\n`);
      lines.push(slug(pr.problem_depth));
      lines.push(`**Emotion Before:** ${slug(pr.emotion_before_purchase)}  **Emotion After:** ${slug(pr.emotion_after_purchase)}`);
      if ((pr.real_quotes||[]).length) lines.push(`\n**Real Quotes**\n${(pr.real_quotes).map(q=>`> "${q}"`).join("\n")}`);
      lines.push("");

      if ((icp.usp_bridge||[]).length) {
        lines.push(`## Problem → USP Bridge`);
        icp.usp_bridge.forEach(b => {
          lines.push(`**Problem:** ${slug(b.consumer_problem)}  →  **USP:** ${slug(b.product_usp)}`);
          lines.push(`_Proof:_ ${slug(b.proof_point)}  |  _Angle:_ ${slug(b.creative_angle)}\n`);
        });
      }

      if ((icp.objection_map||[]).length) {
        lines.push(`## Objection Map`);
        icp.objection_map.forEach(o => lines.push(`- **${slug(o.objection)}** → ${slug(o.counter)} — _"${slug(o.ad_line)}"_`));
        lines.push("");
      }

      if ((icp.concepts||[]).length) {
        lines.push(`## Concept Recommendations`);
        icp.concepts.forEach(c => lines.push(`- **${slug(c.concept)}** [${slug(c.format)}] — ${slug(c.rationale)}`));
        lines.push("");
      }

      if ((cr.hooks||[]).length) {
        lines.push(`## Hooks`);
        cr.hooks.forEach((h,i) => {
          lines.push(`**H${i+1} [${slug(h.type)}]:** "${slug(h.hook)}"`);
          lines.push(`  _${slug(h.why_it_works)}_\n`);
        });
      }

      if (cr.static_ad) {
        lines.push(`## Static Ad Copy`);
        lines.push(`**Headline:** ${slug(cr.static_ad.headline)}`);
        lines.push(`**Body:** ${slug(cr.static_ad.body_copy)}`);
        lines.push(`**USP Line:** ${slug(cr.static_ad.usp_line)}`);
        lines.push(`**CTA:** ${slug(cr.static_ad.cta)}\n`);
      }

      if ((cr.body_copy_variations||[]).length) {
        lines.push(`## Body Copy Variations`);
        cr.body_copy_variations.forEach(v => {
          lines.push(`**${slug(v.angle)}**\n${slug(v.copy)}\n`);
        });
      }

      if (icp.proven_formula) {
        const f = icp.proven_formula;
        lines.push(`## Proven Formula (Windsor AI)`);
        lines.push(`**Winning Angle:** ${slug(f.winning_angle)}  |  **ROAS:** ${slug(f.roas)}  |  **Format:** ${slug(f.format)}`);
        lines.push(`**Why it works:** ${slug(f.why_it_works)}`);
        lines.push(`**Do:** ${slug(f.do_this)}`);
        lines.push(`**Don't:** ${slug(f.dont_do_this)}\n`);
      }
    });

    return lines.join("\n");
  }

  const [copied, setCopied] = useState(false);
  function copyMarkdown() {
    navigator.clipboard.writeText(buildMarkdown()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const OUTPUT_TABS = [
    {key:"research",        label:"Research Intelligence"},
    {key:"windsor",         label:"Ad Performance"},
    ...(creativeIntel ? [{key:"creative_intel", label:"Creative Intel ✦"}] : []),
    ...icps.map((icp,i)=>({key:"icp_"+i, label:icp.profile?.name||"ICP "+(i+1)})),
  ];

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.ink}}>
      <TopBar
        left={<button onClick={onReset} style={{background:"none",border:"1px solid "+T.rule,color:T.muted,padding:"8px 16px",borderRadius:"4px",cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:"11px"}}>← New Brief</button>}
        center={<div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>{data.brand} · {data.product}</div>}
        right={<div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          <button onClick={copyMarkdown} style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",padding:"6px 16px",borderRadius:"4px",cursor:"pointer",background:"rgba(100,160,255,0.1)",color:T.blue,border:"1px solid rgba(100,160,255,0.3)",letterSpacing:"0.05em"}}>{copied ? "✓ Copied" : "⎘ Copy MD"}</button>
          <button onClick={exportJSON} style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",padding:"6px 16px",borderRadius:"4px",cursor:"pointer",background:"rgba(200,75,47,0.15)",color:"#c84b2f",border:"1px solid rgba(200,75,47,0.4)",letterSpacing:"0.05em"}}>↓ Export JSON</button>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",padding:"4px 12px",borderRadius:"2px",background:"rgba(50,200,80,0.1)",color:"rgba(80,220,100,0.7)",border:"1px solid rgba(50,200,80,0.2)"}}>READY FOR DESIGN</span>
        </div>}
      />

      {data?.core_problem&&(
        <div style={{background:"rgba(200,75,47,0.08)",borderBottom:"1px solid rgba(200,75,47,0.2)",padding:"12px 40px",display:"flex",alignItems:"center",gap:"12px"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.accent,letterSpacing:"0.15em",flexShrink:0}}>CORE PROBLEM</span>
          <span style={{fontSize:"13px",color:T.ink}}>{data.core_problem}</span>
        </div>
      )}

      {data?.competitor_gap&&(
        <div style={{background:"rgba(100,160,255,0.04)",borderBottom:"1px solid rgba(100,160,255,0.12)",padding:"10px 40px",display:"flex",alignItems:"center",gap:"12px"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:T.blue,letterSpacing:"0.15em",flexShrink:0}}>COMPETITOR GAP</span>
          <span style={{fontSize:"12px",color:T.muted}}>{data.competitor_gap}</span>
        </div>
      )}

      {/* Tab bar */}
      <div style={{display:"flex",borderBottom:"1px solid "+T.rule,padding:"0 40px",background:T.bg,overflowX:"auto"}}>
        {OUTPUT_TABS.map(({key,label})=>{
          const isResearch = key==="research";
          return (
            <button key={key} onClick={()=>setActiveTab(key)}
              style={{background:"none",border:"none",color:activeTab===key?T.ink:T.muted,padding:"14px 20px",cursor:"pointer",fontSize:"12px",fontFamily:"'DM Mono',monospace",display:"flex",alignItems:"center",gap:"8px",borderBottom:"2px solid "+(activeTab===key?(isResearch?"rgba(76,175,80,0.8)":T.accent):"transparent"),whiteSpace:"nowrap",marginBottom:"-1px"}}>
              {isResearch&&<span style={{width:"6px",height:"6px",borderRadius:"50%",background:"rgba(76,175,80,0.8)",display:"inline-block"}}/>}
              {label}
            </button>
          );
        })}
      </div>

      <div style={{maxWidth:"1040px",margin:"0 auto",padding:"32px 40px 80px"}}>

        {activeTab==="research"       && <ResearchIntelligenceTab data={researchData}/>}
        {activeTab==="windsor"        && <WindsorPanel data={windsorAngles}/>}
        {activeTab==="creative_intel" && <CreativeIntelPanel data={creativeIntel}/>}

        {icps.map((icp,i)=>(
          activeTab==="icp_"+i && (
            <ICPOutput key={i} icp={icp} brand={data.brand} product={data.product} visualIntel={creativeIntel}/>
          )
        ))}

        {activeTab===("icp_"+(icps.length-1)) && data.global_ad_insights && (
          <div style={{marginTop:"48px",paddingTop:"32px",borderTop:"1px solid "+T.rule}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:T.accent,letterSpacing:"0.18em",marginBottom:"20px"}}>GLOBAL AD INSIGHTS — ACROSS ALL ICPs</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
              <Card>
                <Label color={T.green}>What Works</Label>
                {(data.global_ad_insights.what_works||[]).map((w,i)=><div key={i} style={{fontSize:"12px",color:T.ink,marginBottom:"6px",display:"flex",gap:"8px"}}><span style={{color:T.green,flexShrink:0}}>✓</span>{w}</div>)}
              </Card>
              <Card>
                <Label color={T.red}>Don't Repeat</Label>
                {(data.global_ad_insights.angles_to_avoid||[]).map((a,i)=><div key={i} style={{fontSize:"12px",color:T.muted,marginBottom:"6px",display:"flex",gap:"8px"}}><span style={{color:T.red,flexShrink:0}}>✗</span>{a}</div>)}
              </Card>
              <Card>
                <Label color={T.accent}>Fresh Angles</Label>
                {(data.global_ad_insights.fresh_angles||[]).map((f,i)=><div key={i} style={{fontSize:"12px",color:T.ink,marginBottom:"6px",display:"flex",gap:"8px"}}><span style={{color:T.accent,flexShrink:0}}>→</span>{f}</div>)}
              </Card>
              <Card>
                <Label color={T.blue}>Competitor Whitespace</Label>
                <div style={{fontSize:"12px",color:T.ink,lineHeight:"1.6"}}>{data.global_ad_insights.competitor_whitespace}</div>
              </Card>
            </div>
          </div>
        )}

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:"1px solid "+T.rule,paddingTop:"24px",marginTop:"40px"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"rgba(255,255,255,0.15)"}}>Brief Engine v6.1 · 9 Sources · Research Intelligence · Problem→USP Bridge</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",padding:"4px 12px",borderRadius:"2px",background:"rgba(50,200,80,0.1)",color:"rgba(80,220,100,0.7)",border:"1px solid rgba(50,200,80,0.2)"}}>READY FOR DESIGN</span>
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────

export default function App() {
  const [screen,       setScreen]       = useState("step1");
  const [urlData,      setUrlData]      = useState(null);
  const [briefData,    setBriefData]    = useState(null);
  const [researchData, setResearchData] = useState(null);
  const [windsorAngles,setWindsorAngles]= useState(null);
  const [windsorLoaded,setWindsorLoaded]= useState(false);
  const [metaAdsData,  setMetaAdsData]  = useState(null);
  const [creativeIntel,setCreativeIntel]= useState(null);
  const [progress,     setProgress]     = useState(defaultProgress);
  const [liveSignals,  setLiveSignals]  = useState([]);
  const [dataPoints,   setDataPoints]   = useState({});
  const [cachedBrief,  setCachedBrief]  = useState(() => loadLastBrief());

  const restoreLastBrief = () => {
    const c = cachedBrief;
    setBriefData(c.brief);
    setResearchData(c.researchIntelligence);
    setWindsorAngles(c.windsorAngles);
    setMetaAdsData(c.metaAdsInsights);
    setCreativeIntel(c.creativeIntelData);
    setScreen("output");
  };

  const mark = (key,state) => setProgress(p=>({...p,[key]:state}));

  const addSignals = (signals, platform) => {
    const extracted = extractLiveSignals(signals, platform);
    if (extracted.length > 0) {
      setLiveSignals(prev => [...prev, ...extracted].slice(-20)); // keep last 20
      setDataPoints(prev => ({...prev, [platform]: (signals.split("---").length||0)}));
    }
  };

  const handleGenerate = async (allInputs) => {
    setProgress(defaultProgress);
    setLiveSignals([]);
    setDataPoints({});
    setScreen("loading");

    try {
      mark("read_urls","running");
      const urlIntelligence = await readUrlsWithClaude(allInputs.brandUrl,allInputs.productUrl,allInputs.otherUrls||[],allInputs.mediaKeywords);
      mark("read_urls",Object.keys(urlIntelligence).length>0?"done":"failed");

      mark("extract","running");
      const flipkartTerms = urlIntelligence.flipkart_search_terms||[];
      const redditTerms   = urlIntelligence.reddit_search_terms||[];
      const redditSubs    = urlIntelligence.reddit_subreddits||[];
      const tiktokTags    = urlIntelligence.tiktok_hashtags||[];
      const igTags        = urlIntelligence.instagram_hashtags||[];
      const quoraTerms    = urlIntelligence.quora_search_terms||[];
      mark("extract",(urlIntelligence.problem_keywords||[]).length>0?"done":"failed");

      // Performance data — Blissclub dashboard first, Windsor direct as fallback
      mark("windsor","running");
      let parsedWindsor = null;
      let windsorRaw = await fetchBlissclubData();
      if (windsorRaw?.length > 0) {
        parsedWindsor = parseCreativeAngles(windsorRaw);
        setWindsorAngles(parsedWindsor);
        setWindsorLoaded(true);
        mark("windsor","done");
      } else {
        // Fallback: Windsor direct (requires WINDSOR_API_KEY in Railway env)
        windsorRaw = await fetchWindsorData();
        if (windsorRaw?.length > 0) {
          parsedWindsor = parseCreativeAngles(windsorRaw);
          setWindsorAngles(parsedWindsor);
          setWindsorLoaded(true);
          mark("windsor","done");
        } else { mark("windsor","failed"); }
      }

      // All independent steps run in parallel — creative_intel, meta_ads, and all 8 scrapers
      const _parallel = await Promise.allSettled([
        // creative_intel
        (async () => {
          mark("creative_intel","running");
          if (allInputs.creativeSheetRows?.length > 0 && windsorRaw?.length > 0) {
            try {
              const joined = joinSheetWithWindsor(allInputs.creativeSheetRows, windsorRaw);
              if (joined.length > 0) {
                const analysed = await analyzeCreativesWithVision(joined);
                const data = computeVisualCorrelations(analysed, joined);
                setCreativeIntel(data);
                mark("creative_intel","done");
                return data;
              }
              mark("creative_intel","failed"); return null;
            } catch(e) { console.error("Creative intel error:",e); mark("creative_intel","failed"); return null; }
          }
          mark("creative_intel", allInputs.creativeSheetRows?.length > 0 ? "failed" : "pending");
          return null;
        })(),
        // meta_ads
        (async () => {
          mark("meta_ads","running");
          try {
            const brandNameForMeta = urlIntelligence?.brand_name || allInputs.brandName || "";
            const competitorNames = (allInputs.competitorNames||"").split(",").map(s=>s.trim()).filter(Boolean);
            const raw = await scrapeMetaAdsLibrary(brandNameForMeta, competitorNames);
            if (raw?.length > 0) {
              const insights = parseMetaAdsInsights(raw);
              setMetaAdsData(insights);
              mark("meta_ads","done");
              return insights;
            }
            mark("meta_ads","failed"); return null;
          } catch(e) { console.error("Meta Ads step failed:",e); mark("meta_ads","failed"); return null; }
        })(),
        // amazon
        (async () => {
          mark("amazon","running");
          const data = await scrapeAmazon(allInputs.amazonUrls||[]);
          mark("amazon", data?"done":"failed");
          if(data) addSignals(data,"amazon");
          return data;
        })(),
        // flipkart
        (async () => {
          mark("flipkart","running");
          const data = await scrapeFlipkart(flipkartTerms);
          mark("flipkart", data?"done":"failed");
          if(data) addSignals(data,"flipkart");
          return data;
        })(),
        // myntra
        (async () => {
          mark("myntra","running");
          const data = await scrapeMyntra(allInputs.myntraUrl);
          mark("myntra", data?"done":"failed");
          if(data) addSignals(data,"myntra");
          return data;
        })(),
        // reddit
        (async () => {
          mark("reddit","running");
          const data = await scrapeReddit(redditTerms,redditSubs);
          mark("reddit", data?"done":"failed");
          if(data) addSignals(data,"reddit");
          return data;
        })(),
        // youtube
        (async () => {
          mark("youtube","running");
          const data = await scrapeYouTube(allInputs.youtubeUrls||[]);
          mark("youtube", data?"done":"failed");
          if(data) addSignals(data,"youtube");
          return data;
        })(),
        // tiktok
        (async () => {
          mark("tiktok","running");
          const data = await scrapeTikTok(tiktokTags);
          mark("tiktok", data?"done":"failed");
          if(data) addSignals(data,"tiktok");
          return data;
        })(),
        // instagram
        (async () => {
          mark("instagram","running");
          const data = await scrapeInstagram(allInputs.instagramUrls||[],igTags);
          mark("instagram", data?"done":"failed");
          if(data) addSignals(data,"instagram");
          return data;
        })(),
        // quora
        (async () => {
          mark("quora","running");
          const data = await scrapeQuora(quoraTerms);
          mark("quora", data?"done":"failed");
          if(data) addSignals(data,"quora");
          return data;
        })(),
      ]);

      const [_ci, _ma, _amz, _fl, _mn, _rd, _yt, _tt, _ig, _qr] = _parallel.map(r => r.status==="fulfilled" ? r.value : null);
      const creativeIntelData = _ci;
      const metaAdsInsights   = _ma;
      const amazonData        = _amz;
      const flipkartData      = _fl;
      const myntraData        = _mn;
      const redditData        = _rd;
      const youtubeData       = _yt;
      const tiktokData        = _tt;
      const instagramData     = _ig;
      const quoraData         = _qr;

      mark("video_analysis","running");
      const videoAnalysis = [];
      for (const url of allInputs.brandContext?.winningAdUrls||[]) {
        if(!url) continue;
        const [transcript,frames] = await Promise.all([transcribeVideo(url),extractFrames(url)]);
        videoAnalysis.push(await analyseVideo(transcript,frames));
      }
      const screenshotAnalysis = await analyseScreenshots(allInputs.screenshots||[]);
      mark("video_analysis",(videoAnalysis.length>0||screenshotAnalysis.length>0)?"done":"failed");

      // ── NEW: Research Intelligence pass ──
      mark("research","running");
      const allScrapedData = { amazon:amazonData, flipkart:flipkartData, myntra:myntraData, reddit:redditData, youtube:youtubeData, tiktok:tiktokData, instagram:instagramData, quora:quoraData };
      const researchIntelligence = await generateResearchIntelligence({
        amazonUrls: allInputs.amazonUrls||[],
        allScrapedData,
        urlIntelligence,
      });
      mark("research", researchIntelligence?"done":"failed");
      setResearchData(researchIntelligence);

      mark("brief","running");
      const brief = await generateFullBrief({
        urlIntelligence,
        finalUSPs: allInputs.finalUSPs||[],
        mediaKeywords: allInputs.mediaKeywords,
        amazonData, flipkartData, myntraData, redditData,
        youtubeData, tiktokData, instagramData, quoraData,
        videoAnalysis, screenshotAnalysis,
        brandContext: allInputs.brandContext,
        researchIntelligence,
        windsorAngles: parsedWindsor,
        metaAdsInsights,
        creativeIntelData,
      });
      mark("brief",brief?"done":"failed");

      if(!brief) throw new Error("Brief generation returned null");
      setBriefData(brief);
      saveLastBrief({ brief, researchIntelligence, windsorAngles: parsedWindsor, metaAdsInsights, creativeIntelData });
      setScreen("output");

    } catch(err) {
      console.error("Pipeline error:",err);
      setScreen("step1");
      alert("Something went wrong: "+err.message);
    }
  };

  return (
    <div style={{minHeight:"100vh",background:T.bg,fontFamily:"'DM Sans',sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      {screen==="step1"&&cachedBrief?.brief&&(
        <div style={{position:"fixed",bottom:"24px",left:"50%",transform:"translateX(-50%)",zIndex:100,background:"rgba(20,20,18,0.96)",border:"1px solid rgba(200,75,47,0.4)",borderRadius:"8px",padding:"12px 20px",display:"flex",alignItems:"center",gap:"16px",boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:T.muted}}>Last brief: <span style={{color:T.ink}}>{cachedBrief.brief?.brand}</span></span>
          <button onClick={restoreLastBrief} style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",padding:"5px 14px",borderRadius:"4px",cursor:"pointer",background:"rgba(200,75,47,0.15)",color:T.accent,border:"1px solid rgba(200,75,47,0.4)"}}>Restore →</button>
          <button onClick={()=>{clearLastBrief();setCachedBrief(null);}} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:"14px",lineHeight:1,padding:"2px"}}>✕</button>
        </div>
      )}
      {screen==="step1"  &&<Step1Screen onNext={data=>{setUrlData(data);setScreen("step2");}}/>}
      {screen==="step2"  &&<Step2Screen urlData={urlData} onGenerate={handleGenerate} onBack={()=>setScreen("step1")}/>}
      {screen==="loading"&&<LoadingScreen brand={urlData?.brandName} progress={progress} liveSignals={liveSignals} dataPoints={dataPoints} windsorLoaded={windsorLoaded}/>}
      {screen==="output" &&<BriefOutput data={briefData} researchData={researchData} windsorAngles={windsorAngles} metaAdsInsights={metaAdsData} creativeIntel={creativeIntel} onReset={()=>{setBriefData(null);setResearchData(null);setCreativeIntel(null);setProgress(defaultProgress);setLiveSignals([]);setDataPoints({});setScreen("step1");clearLastBrief();setCachedBrief(null);}}/>}
    </div>
  );
}
