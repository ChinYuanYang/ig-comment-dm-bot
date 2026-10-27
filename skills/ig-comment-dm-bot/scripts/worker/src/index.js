// IG 留言關鍵字自動私訊（Cloudflare Worker 範本）
// 流程：讀者留言含關鍵字 → 私訊＋留言底下公開回覆 → （追蹤門檻打開時）讀者回覆或按「我追蹤好了」→ 查追蹤 → 傳檔案或傳按鈕
// 設定都在 wrangler.toml 的 [vars]，活動清單在 CAMPAIGNS；程式本身換活動不用改。

const API = "https://graph.instagram.com/v24.0";
const DAY = 86400;

// ── 記事本：誰拿過檔案、哪則留言回過了 ─────────────────────────
// 有綁 D1（env.DB）就寫 D1：免費方案每天 10 萬列，KV 只有 1,000 次。沒綁就照舊用 KV。
// 換到 D1 之前寫在 KV 的紀錄照樣讀得到（D1 查不到就回頭看 KV），所以不用搬資料。
let tableReady = false;
async function memGet(env, k) {
  if (env.DB) {
    if (!tableReady) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)").run();
      tableReady = true;
    }
    const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ? AND exp > ?").bind(k, Date.now()).first();
    if (row) return row.v;
  }
  return env.KV.get(k);
}

async function memPut(env, k, v, ttl) {
  if (!env.DB) return env.KV.put(k, v, { expirationTtl: ttl });
  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)").bind(k, v, Date.now() + ttl * 1000).run();
}

// 每月換權杖時順便清掉過期的紀錄
async function memCleanup(env) {
  if (env.DB) await env.DB.prepare("DELETE FROM kv WHERE exp < ?").bind(Date.now()).run();
}

// ── 訊息文案（活動可以在 CAMPAIGNS 裡用 ask_text／file_text 覆寫）──────────
const TEXT = {
  ask: (c) => c.ask_text || `謝謝你想要${c.name} 🌻\n回我一句「${c.keyword}」，我就把檔案傳給你`,
  file: (c) => c.file_text || `給你！${c.name} 👇\n\n${c.file_url}`,
  follow: (env) => `檔案準備好了！\n追蹤 @${env.IG_USERNAME} 之後按「我追蹤好了」，我馬上傳給你 🌻`,
  notYet: "我這邊還沒看到你的追蹤耶，IG 有時候會慢幾秒。\n追蹤之後再按一次「我追蹤好了」🙏",
  // 留言底下的公開回覆，輪流用，避免每句都一樣
  publicReplies: [
    "私訊你了，記得看一下訊息 🌻",
    "傳到你的私訊囉，沒看到可以找找「訊息請求」🙏",
    "已經私訊給你了，有問題再跟我說 🌻",
  ],
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // 手動立刻掃一次留言（測試或補跑用，要帶 RUN_KEY）
    if (url.pathname === "/run" && env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY) {
      // 補發用參數：minutes 回頭看幾分鐘（最多 7 天）、public=0 不公開回覆、delay 每則間隔毫秒、limit 這次最多幾則
      // 例：停擺一段時間後慢慢補 → /run?key=…&minutes=120&delay=6000&limit=8（每次最多 8 則，多跑幾次）
      const q = url.searchParams;
      const opts = {
        minutes: Math.min(Number(q.get("minutes")) || 30, 7 * 24 * 60),
        publicReply: q.get("public") !== "0",
        delayMs: Math.min(Number(q.get("delay")) || 0, 10000),
        limit: Number(q.get("limit")) || Infinity,
      };
      const log = [];
      await guard(env, "run", () => pollComments(env, log, opts));
      return new Response(log.join("\n") || "no new comments");
    }
    // 一鍵設定（不用終端機）：查自己的 IG 編號、替帳號訂閱私訊通知、列出最近私訊過的人（找測試小號編號用）
    if (url.pathname === "/setup" && env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY) {
      return new Response(await setup(env), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // 測試通知信：確認出事時真的寄得到（要先設 ALERT_URL）
    if (url.pathname === "/alert-test" && env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY) {
      ALERTS.push({ kind: "test", subject: "測試信：通知功能正常", detail: "這是測試，小幫手沒有出問題。" });
      return new Response(await flushAlerts(env, true));
    }
    if (url.pathname !== "/webhook") return new Response("ok");

    // Meta 後台設定 webhook 時的握手
    if (req.method === "GET") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env.HUB_VERIFY;
      return ok ? new Response(url.searchParams.get("hub.challenge")) : new Response("forbidden", { status: 403 });
    }

    const raw = await req.text();
    if (!(await signatureOk(raw, req.headers.get("X-Hub-Signature-256"), env))) {
      return new Response("bad signature", { status: 401 });
    }
    ctx.waitUntil(guard(env, "webhook", () => handleWebhook(JSON.parse(raw), env)));
    return new Response("EVENT_RECEIVED");
  },

  async scheduled(event, env, ctx) {
    if (event.cron === env.REFRESH_CRON) ctx.waitUntil(refreshToken(env).then(() => memCleanup(env)));
    else ctx.waitUntil(guard(env, "poll", () => pollComments(env)));
  },
};

// ── 備援：定時掃最近幾篇貼文的留言 ─────────────────────────
// 主力是留言通知（webhook），幾秒內就處理；這裡只補 90 秒前、通知可能漏掉的留言，避免兩邊同時回。
async function pollComments(env, log = [], opts = {}) {
  const token = await getToken(env);
  const media = await ig(`/me/media?fields=id&limit=${env.WATCH_POSTS}`, token);
  // 只回頭看 30 分鐘：通知漏掉的留言這段時間內就補到；看 7 天的話，處理過的舊留言每分鐘都要再查一次 KV，
  // 關鍵字留言累積約 70 則就會用完免費方案每天 10 萬次讀取。IG 回傳的留言新的在前，看到更舊的就停。
  const since = Date.now() - (opts.minutes || 30) * 60 * 1000;
  let sent = 0;

  for (const m of media.data || []) {
    let next = `/${m.id}/comments?fields=id,text,timestamp,from{id,username}&limit=50`;
    for (let page = 0; next && page < 4; page++) {
      const res = await ig(next, token);
      let reachedOld = false;
      for (const c of res.data || []) {
        if (Date.parse(c.timestamp) < since) { reachedOld = true; break; }
        if (Date.now() - Date.parse(c.timestamp) < 90 * 1000) continue;
        if (sent >= (opts.limit || Infinity)) return;
        if (await handleComment(c, token, env, log, opts)) {
          sent++;
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        }
      }
      next = !reachedOld && res.paging?.next ? res.paging.next.replace(API, "") : null;
    }
  }
}

// ── 一則留言：含關鍵字、不是自己、沒處理過 → 私訊＋公開回覆 ──────────
async function handleComment(c, token, env, log = [], opts = {}) {
  const camp = matchCampaign(c.text, env);
  if (!camp) return;
  if (!c.from || c.from.id === env.IG_USER_ID || !allowed(c.from.id, env)) return;
  if (await memGet(env, `c:${c.id}`)) return;
  await memPut(env, `c:${c.id}`, "1", 8 * DAY);

  // 不檢查追蹤，或這個人已經拿過這份檔案 → 直接給；否則先請他回一句（回覆才能查追蹤）
  const already = (await memGet(env, `s:${c.from.id}:${camp.keyword}`)) === "sent";
  const direct = !followGate(env) || already;
  const r = await send({ recipient: { comment_id: c.id }, message: { text: direct ? TEXT.file(camp) : TEXT.ask(camp) } }, token);
  const line = `private reply ${c.from.username} [${camp.keyword}] ${direct ? "file" : "ask"} ${JSON.stringify(r).slice(0, 160)}`;
  console.log(line);
  log.push(line);
  if (!r.recipient_id) return true;

  if (direct) await memPut(env, `s:${r.recipient_id}:${camp.keyword}`, "sent", 90 * DAY);
  else await memPut(env, `p:${r.recipient_id}`, camp.keyword, 7 * DAY);

  if (opts.publicReply === false) return true;
  const pick = TEXT.publicReplies[Number(c.id.slice(-3)) % TEXT.publicReplies.length];
  const pr = await igPost(`/${c.id}/replies`, { message: pick }, token);
  log.push(`public reply ${c.from.username} ${JSON.stringify(pr).slice(0, 120)}`);
  return true;
}

// ── 收到留言通知、私訊或按鈕 ──────────────────────────────
async function handleWebhook(body, env) {
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field === "comments" && ch.value?.id) await handleComment(ch.value, await getToken(env), env);
    }
    for (const ev of entry.messaging || []) {
      const uid = ev.sender?.id;
      if (!uid || uid === env.IG_USER_ID || ev.message?.is_echo) continue;
      if (!allowed(uid, env)) { console.log("disabled, skip", uid); continue; }

      const payload = ev.postback?.payload || "";
      if (payload.startsWith("CHECK_FOLLOW|")) {
        const camp = campaigns(env).find((c) => c.keyword === payload.slice(13));
        if (camp) await checkAndDeliver(uid, camp, true, env);
      } else if (ev.message?.text) {
        // 私訊裡打了關鍵字，或剛被請「回我一句」的人回了任何話
        // 已經拿過那份的人，「等待中」紀錄不擦（擦掉也算一次 KV 寫入），改成這裡跳過
        let pending = await memGet(env, `p:${uid}`);
        if (pending && (await memGet(env, `s:${uid}:${pending}`)) === "sent") pending = null;
        const camp = matchCampaign(ev.message.text, env) || campaigns(env).find((c) => c.keyword === pending);
        if (camp) await checkAndDeliver(uid, camp, false, env);
      }
    }
  }
}

async function checkAndDeliver(uid, camp, fromButton, env) {
  const token = await getToken(env);
  let ok = !followGate(env);
  if (!ok) {
    const p = await ig(`/${uid}?fields=is_user_follow_business`, token);
    ok = p.is_user_follow_business === true;
  }
  if (ok) {
    await send({ recipient: { id: uid }, message: { text: TEXT.file(camp) } }, token);
    await memPut(env, `s:${uid}:${camp.keyword}`, "sent", 90 * DAY);
    console.log("file sent", uid, camp.keyword);
  } else {
    await send({ recipient: { id: uid }, message: buttons(fromButton ? TEXT.notYet : TEXT.follow(env), camp, env) }, token);
    console.log("ask follow", uid, camp.keyword, fromButton);
  }
}

function buttons(text, camp, env) {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: [
          { type: "web_url", url: `https://www.instagram.com/${env.IG_USERNAME}/`, title: "去追蹤" },
          { type: "postback", title: "我追蹤好了", payload: `CHECK_FOLLOW|${camp.keyword}` },
        ],
      },
    },
  };
}

async function setup(env) {
  const token = await getToken(env);
  const me = await ig("/me?fields=user_id,username,account_type", token);
  if (me.error) return `權杖有問題：${me.error.message}`;
  const sub = await igPost("/me/subscribed_apps", { subscribed_fields: "messages,messaging_postbacks" }, token);
  const conv = await ig("/me/conversations?platform=instagram&fields=participants&limit=10", token);
  const people = (conv.data || []).flatMap((c) => c.participants?.data || [])
    .filter((p) => p.username !== me.username).map((p) => `  ${p.username}：${p.id}`);
  return [
    `IG_USER_ID 請填：${me.user_id}`,
    `IG_USERNAME 請填：${me.username}（帳號類型 ${me.account_type}）`,
    `訂閱私訊通知：${sub.success ? "成功" : JSON.stringify(sub)}`,
    "最近私訊過的人（測試小號的編號填進 TEST_USERS）：",
    ...(people.length ? [...new Set(people)] : ["  （沒有，請先用小號私訊你的帳號一句話再重整這頁）"]),
  ].join("\n");
}

// ── 權杖：存在 KV，每月換新（官方：至少 24 小時、未過期才能換，換完再撐 60 天）──
async function getToken(env) {
  return (await env.KV.get("token")) || env.IG_TOKEN;
}

async function refreshToken(env) {
  const t = await getToken(env);
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${t}`).then((x) => x.json());
  if (r.access_token) {
    await env.KV.put("token", r.access_token);
    console.log("token refreshed, expires_in", r.expires_in);
  } else {
    console.log("token refresh failed", JSON.stringify(r));
  }
}

// ── 小工具 ──────────────────────────────────────────────
function campaigns(env) {
  return JSON.parse(env.CAMPAIGNS);
}

function matchCampaign(text, env) {
  const t = (text || "").replace(/\s/g, "");
  return campaigns(env).find((c) => t.includes(c.keyword.replace(/\s/g, "")));
}

function followGate(env) {
  return env.FOLLOW_GATE !== "false";
}

// 總開關關著時，只回應測試帳號
function allowed(uid, env) {
  return env.ENABLED === "true" || (env.TEST_USERS || "").split(",").includes(uid);
}

// ── 出問題寄信通知（選配：設了 ALERT_URL 才會寄，經 Google Apps Script 寄到你的 Gmail）────────
// IG 回這些錯誤代表小幫手整個停了或被限制；同一種問題 1 小時內只寄一次
const SERIOUS = {
  190: "IG 權杖失效（鑰匙過期或被撤銷）",
  200: "Meta 擋住了 API（常見原因：開發者帳號要重新確認）",
  368: "Meta 暫時限制發訊息（可能被當成濫發）",
  4: "呼叫 IG 太頻繁，被暫時限流", 17: "呼叫 IG 太頻繁，被暫時限流", 32: "呼叫 IG 太頻繁，被暫時限流", 613: "呼叫 IG 太頻繁，被暫時限流",
};
let ALERTS = [];

function watch(json, what) {
  const e = json?.error;
  if (e && SERIOUS[e.code]) {
    ALERTS.push({ kind: `ig${e.code}`, subject: SERIOUS[e.code], detail: `${what}：${e.message}（code ${e.code}${e.error_subcode ? `，subcode ${e.error_subcode}` : ""}）` });
  }
  return json;
}

async function guard(env, where, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(where, "error", e.stack);
    const kv = /KV|D1|429|limit/i.test(String(e.message));
    ALERTS.push({
      kind: kv ? "kv" : "crash",
      subject: kv ? "Cloudflare 資料庫（KV／D1）今天的免費額度用完了" : "小幫手程式出錯",
      detail: `${where}：${e.message}`,
    });
  } finally {
    await flushAlerts(env);
  }
}

async function flushAlerts(env, force = false) {
  const list = ALERTS;
  ALERTS = [];
  if (!env.ALERT_URL || !list.length) return "no alert url or nothing to send";
  const cache = caches.default;
  const out = [];
  for (const a of list) {
    const key = new Request(`https://alerts.invalid/${a.kind}`);
    if (!force && (await cache.match(key))) continue;
    const time = new Date().toLocaleString("zh-TW", { timeZone: env.TIMEZONE || "Asia/Taipei", hour12: false });
    const body = [
      `IG 留言自動私訊小幫手出狀況了：${a.subject}`,
      "",
      `時間：${time}`,
      `細節：${a.detail}`,
      "",
      "這段時間留言或回私訊的人，可能沒收到檔案。",
      "",
      "你可以：",
      "1. 把這封信貼給你的 AI，請它查原因、補發漏掉的人（留言後 7 天內都補得到；慢慢補：/run?key=…&minutes=分鐘數&delay=6000&limit=8）。",
      "2. 如果是 Meta 擋住：用個人 FB 身分（不是粉專身分）打開 https://developers.facebook.com/apps/ ，看要不要確認帳號。",
      "3. 如果是 Cloudflare 額度用完：每天 UTC 00:00（台灣早上 8 點）自動恢復；還沒綁 D1 的話先綁（指南第 6 步），一天可以寫 10 萬筆；綁了還是常發生，再考慮升級 Cloudflare 付費方案。",
      "",
      "（同一種問題 1 小時內只寄一次）",
    ].join("\n");
    const r = await fetch(env.ALERT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: a.subject, body }),
    }).then((x) => x.text()).catch((e) => `fetch failed: ${e.message}`);
    out.push(`${a.kind}: ${r.slice(0, 60)}`);
    await cache.put(key, new Response("1", { headers: { "Cache-Control": "max-age=3600" } }));
  }
  return out.join("\n") || "skipped (sent within the last hour)";
}

async function ig(path, token) {
  const u = new URL(API + path);
  u.searchParams.set("access_token", token);
  return fetch(u).then((r) => r.json()).then((j) => watch(j, path.split("?")[0]));
}

async function igPost(path, params, token) {
  return fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }).then((r) => r.json()).then((j) => watch(j, "留言板回覆"));
}

async function send(payload, token) {
  return fetch(`${API}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).then((j) => watch(j, "傳私訊"));
}

// Meta 用 App 密鑰簽章；「Instagram 登入」這類 App 有兩把密鑰，兩把都試
async function signatureOk(raw, header, env) {
  if (!header?.startsWith("sha256=")) return false;
  const want = header.slice(7);
  for (const secret of [env.APP_SECRET, env.IG_APP_SECRET].filter(Boolean)) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex === want) return true;
  }
  return false;
}
