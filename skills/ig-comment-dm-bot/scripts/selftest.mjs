// 範本自我測試：不連 IG、不連 Cloudflare，用假的 KV 與假的 IG 回應跑完整流程。
// 用法：node scripts/selftest.mjs（改過 worker/src/index.js 之後一定要跑）
import { createHmac } from "node:crypto";
import worker from "./worker/src/index.js";

const SECRET = "test-secret";
const calls = [];
let follows = false;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
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
  else if (url.includes("/M1/comments")) json = { data: [] };
  return { json: async () => json };
};

const store = new Map();
const KV = {
  get: async (k) => store.get(k) ?? null,
  put: async (k, v) => void store.set(k, v),
  delete: async (k) => void store.delete(k),
};

const env = {
  KV, IG_USER_ID: "OWNER", IG_USERNAME: "your.account", ENABLED: "true", TEST_USERS: "",
  FOLLOW_GATE: "true", WATCH_POSTS: "3", REFRESH_CRON: "0 3 1 * *", HUB_VERIFY: "hv", RUN_KEY: "rk",
  APP_SECRET: SECRET, IG_TOKEN: "tok",
  CAMPAIGNS: JSON.stringify([
    { keyword: "懶人包", name: "《上班族權益懶人包》", file_url: "https://example.com/kit.pdf" },
    { keyword: "履歷", name: "《履歷模板》", file_url: "https://example.com/cv.pdf" },
  ]),
};

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
check("記住他在等懶人包", store.get("p:U1") === "懶人包");

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
check("記成已拿過", store.get("s:U1:懶人包") === "sent" && !store.has("p:U1"));

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

console.log(fail ? `\n${fail} 項失敗` : "\n全部通過");
process.exit(fail ? 1 : 0);
