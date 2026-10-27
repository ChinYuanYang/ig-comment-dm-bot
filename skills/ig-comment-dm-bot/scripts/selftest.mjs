// 範本自我測試：不連 IG、不連 Cloudflare，用假的 KV／D1 與假的 IG 回應跑完整流程。
// 用法：node scripts/selftest.mjs（改過 worker/src/index.js 之後一定要跑）
// 會跑兩輪：先只用 KV，再加上 D1（記事本寫 D1、舊紀錄還在 KV），兩輪都通過才算過。
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker from "./worker/src/index.js";

const SECRET = "test-secret";
const calls = [];
let follows = false;
let pollComments = [];

const mails = [];
let igError = null; // 設成 { code: 200, message: "..." } 模擬 Meta 擋住
const cacheStore = new Map();
globalThis.caches = { default: { match: async (r) => cacheStore.get(r.url), put: async (r, v) => void cacheStore.set(r.url, v) } };

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://mail.test")) { mails.push(JSON.parse(init.body)); return { text: async () => "ok" }; }
  if (igError) return { json: async () => ({ error: igError }) };
  const body = init.body ? String(init.body) : "";
  calls.push({ url, body });
  let json = {};
  if (url.includes("/me/messages")) json = { recipient_id: "U1", message_id: "m" };
  else if (url.includes("/replies")) json = { id: "r" };
  else if (url.includes("is_user_follow_business")) json = { is_user_follow_business: follows };
  else if (url.includes("/me/media")) json = { data: [{ id: "M1" }] };
  else if (url.includes("/me?fields=user_id")) json = { user_id: "OWNER", username: "your.account", account_type: "BUSINESS" };
  else if (url.includes("subscribed_apps")) json = { success: true };
  else if (url.includes("/me/conversations")) json = { data: [{ participants: { data: [{ username: "your.account", id: "OWNER" }, { username: "alt.account", id: "ALT1" }] } }] };
  else if (url.includes("/M1/comments")) json = { data: pollComments };
  return { json: async () => json };
};

const USE_D1 = process.env.SELFTEST_D1 === "1";
console.log(USE_D1 ? "\n── 第 2 輪：KV＋D1 ──" : "── 第 1 輪：只用 KV ──");

const store = new Map();
const kvPuts = [];
const KV = {
  get: async (k) => store.get(k) ?? null,
  put: async (k, v) => { kvPuts.push(k); store.set(k, v); },
  delete: async (k) => void store.delete(k),
};

// 假的 D1：只認得程式用到的四種 SQL
const d1 = new Map();
let d1Reads = 0;
function dbRun(sql, a) {
  if (sql.startsWith("CREATE")) return {};
  if (sql.startsWith("INSERT")) { d1.set(a[0], { v: a[1], exp: a[2] }); return {}; }
  if (sql.startsWith("DELETE")) { for (const [k, r] of d1) if (r.exp < a[0]) d1.delete(k); return {}; }
  throw new Error("假 D1 不認得：" + sql);
}
const DB = {
  prepare: (sql) => ({
    run: async () => dbRun(sql, []),
    bind: (...a) => ({
      run: async () => dbRun(sql, a),
      first: async () => { d1Reads++; const r = d1.get(a[0]); return r && r.exp > a[1] ? { v: r.v } : null; },
    }),
  }),
};
// 記事本裡的值：D1 有就看 D1，沒有看 KV（跟程式的讀法一樣）
const mem = (k) => d1.get(k)?.v ?? store.get(k);

const env = {
  KV, IG_USER_ID: "OWNER", IG_USERNAME: "your.account", ENABLED: "true", TEST_USERS: "",
  FOLLOW_GATE: "true", WATCH_POSTS: "3", REFRESH_CRON: "0 3 1 * *", HUB_VERIFY: "hv", RUN_KEY: "rk",
  APP_SECRET: SECRET, IG_TOKEN: "tok",
  CAMPAIGNS: JSON.stringify([
    { keyword: "懶人包", name: "《上班族權益懶人包》", file_url: "https://example.com/kit.pdf" },
    { keyword: "履歷", name: "《履歷模板》", file_url: "https://example.com/cv.pdf" },
  ]),
};
if (USE_D1) env.DB = DB;

async function hook(entry, secret = SECRET) {
  const raw = JSON.stringify({ object: "instagram", entry: [entry] });
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const waits = [];
  const res = await worker.fetch(
    new Request("https://x.dev/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }),
    env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res.status;
}
const comment = (id, text, from = "U1") => ({ changes: [{ field: "comments", value: { id, text, from: { id: from, username: "reader" } } }] });
const dm = (text, from = "U1") => ({ messaging: [{ sender: { id: from }, message: { text } }] });
const tap = (payload, from = "U1") => ({ messaging: [{ sender: { id: from }, postback: { payload } }] });
const sent = () => calls.filter((c) => c.url.includes("/me/messages")).map((c) => JSON.parse(c.body));

let fail = 0;
function check(name, cond) { console.log(`${cond ? "✅" : "❌"} ${name}`); if (!cond) fail++; }

// 1. 留言「懶人包」→ 私訊請他回一句＋公開回覆
calls.length = 0;
await hook(comment("C1", "我要 懶人包！"));
check("留言觸發私訊（請他回一句）", sent()[0]?.recipient?.comment_id === "C1" && sent()[0].message.text.includes("回我一句「懶人包」"));
check("留言底下公開回覆", calls.some((c) => c.url.includes("/C1/replies")));
check("記住他在等懶人包", mem("p:U1") === "懶人包");

// 2. 同一則留言重複通知 → 不重複回
calls.length = 0;
await hook(comment("C1", "懶人包"));
check("同一則留言不重複處理", sent().length === 0);

// 3. 他隨便回一句，還沒追蹤 → 傳按鈕
calls.length = 0;
await hook(dm("好"));
const b = sent()[0]?.message?.attachment?.payload;
check("沒追蹤 → 傳兩顆按鈕", b?.buttons?.length === 2 && b.buttons[1].payload === "CHECK_FOLLOW|懶人包");

// 4. 按「我追蹤好了」但還沒追蹤 → 還沒看到
calls.length = 0;
await hook(tap("CHECK_FOLLOW|懶人包"));
check("按了但還沒追蹤 → 提醒再按一次", sent()[0]?.message?.attachment?.payload?.text.includes("還沒看到"));

// 5. 追蹤後再按 → 傳檔案
follows = true; calls.length = 0;
await hook(tap("CHECK_FOLLOW|懶人包"));
check("追蹤後 → 傳懶人包連結", sent()[0]?.message?.text?.includes("https://example.com/kit.pdf"));
check("記成已拿過", mem("s:U1:懶人包") === "sent");

// 5b. 拿到後隨便再傳一句 → 不再重傳（等待紀錄不擦，省 KV 寫入）
calls.length = 0;
await hook(dm("謝謝"));
check("拿到後再傳話 → 不重傳檔案", sent().length === 0);

// 6. 拿過的人再留言 → 私訊直接給連結
calls.length = 0;
await hook(comment("C2", "懶人包"));
check("拿過的人再留言 → 直接給連結", sent()[0]?.message?.text?.includes("kit.pdf"));

// 7. 第二個活動：留言「履歷」→ 對應另一份檔案的流程
follows = false; calls.length = 0;
await hook(comment("C3", "履歷 +1"));
check("多活動：履歷走自己的流程", sent()[0]?.message?.text?.includes("回我一句「履歷」"));

// 8. 自己的帳號、沒有關鍵字 → 不理
calls.length = 0;
await hook(comment("C4", "懶人包", "OWNER"));
await hook(comment("C5", "好文推"));
check("自己留言、沒關鍵字都不回", sent().length === 0);

// 9. 總開關關著 → 只回測試帳號
env.ENABLED = "false"; env.TEST_USERS = "TESTER"; calls.length = 0;
await hook(comment("C6", "懶人包", "STRANGER"));
await hook(comment("C7", "懶人包", "TESTER"));
check("總開關關著 → 陌生人不回、測試帳號照回", sent().length === 1 && sent()[0].recipient.comment_id === "C7");
env.ENABLED = "true";

// 10. 追蹤門檻關掉 → 留言就直接給檔案
env.FOLLOW_GATE = "false"; calls.length = 0;
await hook(comment("C8", "懶人包", "U9"));
check("FOLLOW_GATE=false → 留言直接給連結", sent()[0]?.message?.text?.includes("kit.pdf"));
env.FOLLOW_GATE = "true";

// 11. 簽章不對 → 擋掉
check("假的通知（簽章錯）被擋", (await hook(comment("C9", "懶人包"), "wrong")) === 401);

// 12. webhook 握手
const hs = await worker.fetch(new Request("https://x.dev/webhook?hub.mode=subscribe&hub.verify_token=hv&hub.challenge=42"), env, {});
check("Meta 握手回傳 challenge", (await hs.text()) === "42");

// 13. 一鍵設定頁
const su = await (await worker.fetch(new Request("https://x.dev/setup?key=rk"), env, {})).text();
check("/setup 給出 IG 編號、訂閱成功、小號編號", su.includes("IG_USER_ID 請填：OWNER") && su.includes("成功") && su.includes("alt.account：ALT1") && !su.includes("your.account："));
const bad = await (await worker.fetch(new Request("https://x.dev/setup?key=wrong"), env, {})).text();
check("/setup 沒帶對鑰匙就不給看", bad === "ok");

// 14. 每分鐘補掃：只補 90 秒～30 分鐘前的留言，更舊的不再查（省 KV 讀取）
const ago = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
pollComments = [
  { id: "P1", text: "懶人包", timestamp: ago(0.5), from: { id: "U20", username: "a" } },
  { id: "P2", text: "懶人包", timestamp: ago(10), from: { id: "U21", username: "b" } },
  { id: "P3", text: "懶人包", timestamp: ago(45), from: { id: "U22", username: "c" } },
];
calls.length = 0;
const kvGet = KV.get; let reads = 0; const d1Before = d1Reads;
if (!USE_D1) KV.get = async (k) => { reads++; return kvGet(k); };
const runLog = await (await worker.fetch(new Request("https://x.dev/run?key=rk"), env, {})).text();
KV.get = kvGet;
if (USE_D1) reads = d1Reads - d1Before;
const polled = sent().map((m) => m.recipient.comment_id);
check("補掃：10 分鐘前漏掉的留言會補回", polled.includes("P2") && runLog.includes("private reply"));
check("補掃：90 秒內的留給通知、45 分鐘前的不再查", !polled.includes("P1") && !polled.includes("P3") && reads <= 3);

// 14. /run 補發：public=0 不公開回覆、limit 限制數量
{
  const many = { data: [1, 2, 3].map((n) => ({ id: `B${n}`, text: "懶人包", timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), from: { id: `R${n}`, username: `r${n}` } })) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input).includes("/M1/comments") ? { json: async () => many } : realFetch(input, init));
  calls.length = 0;
  const out = await (await worker.fetch(new Request("https://x.dev/run?key=rk&minutes=60&public=0&limit=2"), env, {})).text();
  globalThis.fetch = realFetch;
  check("/run 補發：只處理 2 則、不公開回覆", sent().length === 2 && !calls.some((c) => c.url.includes("/replies")) && out.includes("private reply"));
}

// 15. 出問題寄信：Meta 擋住 → 寄 1 封；1 小時內同類不重複寄
env.ALERT_URL = "https://mail.test/x";
igError = { code: 200, message: "API access blocked." };
for (let i = 0; i < 2; i++) {
  const waits = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
igError = null;
check("Meta 擋住 → 寄 1 封信、不重複寄", mails.length === 1 && mails[0].subject.includes("Meta 擋住"));

// 16. KV 額度用完（寫入失敗）→ 寄信
{
  const realPut = KV.put, realPrepare = DB.prepare;
  KV.put = async () => { throw new Error("KV PUT failed: 429 Too Many Requests"); };
  DB.prepare = (sql) => (sql.startsWith("INSERT") ? { bind: () => ({ run: async () => { throw new Error("D1_ERROR: Exceeded maximum DB rows written"); } }) } : realPrepare(sql));
  await hook(comment("C10", "懶人包", "U20"));
  KV.put = realPut; DB.prepare = realPrepare;
  check("資料庫寫不進去 → 寄「額度用完」的信", mails.some((m) => m.subject.includes("額度用完")));
}

// 17. /alert-test 一定寄得出去
const at = await (await worker.fetch(new Request("https://x.dev/alert-test?key=rk"), env, {})).text();
check("/alert-test 寄出測試信", at.includes("test: ok") && mails.some((m) => m.subject.includes("測試信")));

// 18.（D1 輪）記事本只寫 D1；換 D1 之前記在 KV 的人照樣認得
if (USE_D1) {
  check("記事本的紀錄都寫進 D1、沒寫 KV", d1.size > 0 && !kvPuts.some((k) => /^[csp]:/.test(k)));
  store.set("s:OLD:懶人包", "sent"); calls.length = 0;
  await hook(comment("C11", "懶人包", "OLD"));
  check("換 D1 前拿過的人再留言 → 直接給連結", sent()[0]?.message?.text?.includes("kit.pdf"));
  d1.set("x:old", { v: "1", exp: Date.now() - 1000 });
  const waits = [];
  await worker.scheduled({ cron: env.REFRESH_CRON }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  check("每月換權杖時清掉過期紀錄", !d1.has("x:old") && d1.has("s:U1:懶人包"));
}

if (fail) { console.log(`\n${fail} 項失敗`); process.exit(1); }
if (USE_D1) { console.log("\n全部通過"); process.exit(0); }
const second = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SELFTEST_D1: "1" }, stdio: "inherit" });
process.exit(second.status ?? 1);
