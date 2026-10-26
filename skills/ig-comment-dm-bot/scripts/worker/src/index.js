// IG 留言關鍵字自動私訊（Cloudflare Worker 範本）
// 流程：讀者留言含關鍵字 → 私訊＋留言底下公開回覆 → （追蹤門檻打開時）讀者回覆或按「我追蹤好了」→ 查追蹤 → 傳檔案或傳按鈕
// 設定都在 wrangler.toml 的 [vars]，活動清單在 CAMPAIGNS；程式本身換活動不用改。

const API = "https://graph.instagram.com/v24.0";
const DAY = 86400;

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
      const log = [];
      await pollComments(env, log);
      return new Response(log.join("\n") || "no new comments");
    }
    // 一鍵設定（不用終端機）：查自己的 IG 編號、替帳號訂閱私訊通知、列出最近私訊過的人（找測試小號編號用）
    if (url.pathname === "/setup" && env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY) {
      return new Response(await setup(env), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
    ctx.waitUntil(handleWebhook(JSON.parse(raw), env).catch((e) => console.log("webhook error", e.stack)));
    return new Response("EVENT_RECEIVED");
  },

  async scheduled(event, env, ctx) {
    if (event.cron === env.REFRESH_CRON) ctx.waitUntil(refreshToken(env));
    else ctx.waitUntil(pollComments(env).catch((e) => console.log("poll error", e.stack)));
  },
};

// ── 備援：定時掃最近幾篇貼文的留言 ─────────────────────────
// 主力是留言通知（webhook），幾秒內就處理；這裡只補 90 秒前、通知可能漏掉的留言，避免兩邊同時回。
async function pollComments(env, log = []) {
  const token = await getToken(env);
  const media = await ig(`/me/media?fields=id&limit=${env.WATCH_POSTS}`, token);
  const since = Date.now() - 7 * DAY * 1000; // 官方規定留言後 7 天內才能私訊

  for (const m of media.data || []) {
    let next = `/${m.id}/comments?fields=id,text,timestamp,from{id,username}&limit=50`;
    for (let page = 0; next && page < 4; page++) {
      const res = await ig(next, token);
      let reachedOld = false;
      for (const c of res.data || []) {
        if (Date.parse(c.timestamp) < since) { reachedOld = true; break; }
        if (Date.now() - Date.parse(c.timestamp) < 90 * 1000) continue;
        await handleComment(c, token, env, log);
      }
      next = !reachedOld && res.paging?.next ? res.paging.next.replace(API, "") : null;
    }
  }
}

// ── 一則留言：含關鍵字、不是自己、沒處理過 → 私訊＋公開回覆 ──────────
async function handleComment(c, token, env, log = []) {
  const camp = matchCampaign(c.text, env);
  if (!camp) return;
  if (!c.from || c.from.id === env.IG_USER_ID || !allowed(c.from.id, env)) return;
  if (await env.KV.get(`c:${c.id}`)) return;
  await env.KV.put(`c:${c.id}`, "1", { expirationTtl: 8 * DAY });

  // 不檢查追蹤，或這個人已經拿過這份檔案 → 直接給；否則先請他回一句（回覆才能查追蹤）
  const already = (await env.KV.get(`s:${c.from.id}:${camp.keyword}`)) === "sent";
  const direct = !followGate(env) || already;
  const r = await send({ recipient: { comment_id: c.id }, message: { text: direct ? TEXT.file(camp) : TEXT.ask(camp) } }, token);
  const line = `private reply ${c.from.username} [${camp.keyword}] ${direct ? "file" : "ask"} ${JSON.stringify(r).slice(0, 160)}`;
  console.log(line);
  log.push(line);
  if (!r.recipient_id) return;

  if (direct) await env.KV.put(`s:${r.recipient_id}:${camp.keyword}`, "sent", { expirationTtl: 90 * DAY });
  else await env.KV.put(`p:${r.recipient_id}`, camp.keyword, { expirationTtl: 7 * DAY });

  const pick = TEXT.publicReplies[Number(c.id.slice(-3)) % TEXT.publicReplies.length];
  const pr = await igPost(`/${c.id}/replies`, { message: pick }, token);
  log.push(`public reply ${c.from.username} ${JSON.stringify(pr).slice(0, 120)}`);
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
        const pending = await env.KV.get(`p:${uid}`);
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
    await env.KV.put(`s:${uid}:${camp.keyword}`, "sent", { expirationTtl: 90 * DAY });
    await env.KV.delete(`p:${uid}`);
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

async function ig(path, token) {
  const u = new URL(API + path);
  u.searchParams.set("access_token", token);
  return fetch(u).then((r) => r.json());
}

async function igPost(path, params, token) {
  return fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }).then((r) => r.json());
}

async function send(payload, token) {
  return fetch(`${API}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
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
