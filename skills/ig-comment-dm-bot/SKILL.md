---
name: ig-comment-dm-bot
version: 0.2.2
description: >-
  IG 留言關鍵字自動私訊：讀者在貼文留言指定關鍵字（例如「懶人包」），自動私訊、在留言底下公開回覆，
  （可選）確認有追蹤後再傳檔案連結。自己架在 Meta App＋Cloudflare 免費方案，不用 ManyChat。
  使用時機：「幫我架 IG 留言自動私訊」「留言 XX 傳檔案」「新增一個留言關鍵字活動」「換懶人包檔案」
  「暫停／打開 IG 小幫手」「讀者說沒收到私訊」。
  不適用：Facebook 粉專留言自動回覆、Threads、只要回覆一般問答的客服機器人、
  要服務「別人的」IG 帳號（那要 Meta 送審與商家驗證），以及寫 IG 貼文文案本身（用 ig-carousel-script）。
user-invocable: true
last-updated: 2026-10-26
---

# IG 留言關鍵字自動私訊

## 使用時機

使用者想辦「留言關鍵字拿檔案」的活動。讀者流程：

```
留言「關鍵字」 → 幾秒內：私訊＋留言底下公開回覆
   ├─ 追蹤門檻關（FOLLOW_GATE=false）→ 私訊直接附連結
   └─ 追蹤門檻開（預設）→ 私訊「回我一句關鍵字」→ 讀者回覆 → 查追蹤
          ├─ 有追蹤 → 傳連結
          └─ 沒追蹤 → [去追蹤] [我追蹤好了] → 追蹤後按 → 傳連結
拿過的人再留言 → 直接給連結
```

先判斷是哪一種請求：

| 請求 | 做法 |
|---|---|
| 第一次架設（Claude Code，會用終端機） | 讀 `references/setup-guide.md`，從第 0 步開始 |
| 第一次架設（不用終端機／要分享給別人） | 讀 `references/web-setup-guide.md`：全程用 Cloudflare 網頁貼程式，`/setup?key=RUN_KEY` 一鍵查 IG 編號、訂閱通知、找小號編號 |
| 新增或換活動（換關鍵字、換檔案） | 只改 wrangler.toml 的 `CAMPAIGNS` → deploy → 用小號測新關鍵字 |
| 暫停／打開 | `ENABLED` 改 "false"／"true" → deploy |
| 讀者說沒收到 | 見下方「排錯」 |

## 不適用情境

- 要替**別人的** IG 帳號架：那需要 Advanced Access（Meta 送審＋商家驗證），本 Skill 只走「服務自己帳號」的路。
- 帳號是私人帳號，或使用者不想註冊 Meta 開發者、Cloudflare：先說明需求，不要硬做。

## 必要輸入

1. IG 帳號名稱（專業帳號、公開）
2. 每個活動的：關鍵字、檔案名稱、下載連結
3. 追蹤門檻要不要開（見下方提醒）
4. 一個測試小號（不在 App 任何角色裡；最好一個有追蹤、一個沒追蹤）

## 判斷與工作流程

0. **走終端機版之前先跑 `node -v`**：沒有 Node.js（或低於 v18）就帶使用者到 nodejs.org 裝 LTS 版，或改走網頁版。新手電腦常常沒有，卡在「找不到指令」最浪費時間。
1. **程式不要從頭寫**。複製 `scripts/worker/` 到使用者的專案資料夾，只填 wrangler.toml 的 `__…__`。範本已處理：留言通知即時回、每分鐘補掃 30 分鐘內漏掉的留言（不重查舊留言，省 KV 讀取額度）、多活動、追蹤門檻、公開回覆輪流三句、測試模式、每月換權杖、驗簽章。
2. **改了 `src/index.js` 就先跑** `node scripts/selftest.mjs`（在本 Skill 資料夾），全部通過才 deploy。
3. **使用者本人按、AI 不代按**：註冊帳號、輸入密碼、同意條款（建立 App、接受測試員邀請、Cloudflare 授權）、發佈 App、公開隱私權政策頁、打開總開關。到這些步驟就停下來，說清楚要按哪一顆、在哪個視窗。
4. **機密不落地**：權杖、App 密鑰只存在 `~/.config/<worker 名稱>/`（chmod 600）和 Cloudflare secret；用剪貼簿＋管線搬，用完清空剪貼簿；不進 Git、不出現在對話。
5. **追蹤門檻提醒（每次架設說一次就好）**：Meta 社群守則「垃圾訊息」不允許要求互動（包含追蹤）才能取得特定內容。帳號被限制時影響整個帳號。說完由使用者決定；選擇記在專案的規格檔。
   https://transparency.meta.com/zh-tw/policies/community-standards/spam/
6. **上線前**一定用小號跑完整流程（setup-guide 第 8 步），使用者點頭才改 `ENABLED = "true"`。上線後馬上 `/run` 一次，確認回 `no new comments`。
7. **貼文文案**：提醒使用者在 caption 第一行就寫「留言「關鍵字」」，並在圖卡角落放索取提示（很多人不會滑到最後一頁）。

## 排錯（讀者說沒收到）

依序檢查，找到就停：

1. 留言是不是**回覆別人的留言**（第二層）？範本只抓貼文底下第一層。
2. 通知剛好漏掉，而且已經超過 30 分鐘？補掃只回頭看 30 分鐘，`/run` 也補不到，請讀者再留一次。留言在**最新 3 篇以外**也不會被補掃（`WATCH_POSTS` 可調大）。
3. `npx -y wrangler@4 tail` 看有沒有 `private reply`；回傳 error code 10／subcode 2534022 → 讀者的回覆早於 `subscribed_apps` 訂閱，請他再回一次。
4. 私訊可能在讀者的「訊息請求」資料夾。
5. 剛改過 cron 頻率：Cloudflare 要幾分鐘才生效，期間用 `/run` 補跑。

## 輸出格式

- 架設：每一步回報 ✅／⏸️（等使用者按）／⛔，最後給一張「讀者流程圖＋目前狀態表（總開關、追蹤門檻、活動清單、測試結果）」。
- 新增活動：列出新的 CAMPAIGNS、測試結果，提醒文案要寫的關鍵字。

## 停止條件

- 讀不到一般讀者的留言：先確認 App 已「發佈」（未發佈時回傳空陣列，不報錯）。
- 使用者沒有測試小號：不上線，先請他準備。
- 使用者想讓 AI 代按發佈、輸入密碼或同意條款：說明要本人按，然後等。

## 驗收標準

- `node scripts/selftest.mjs` 全部通過（目前 19 項）。
- 小號實測：留言 → 幾秒內收到私訊與公開回覆；沒追蹤 → 按鈕 → 追蹤後拿到檔案。
- `/run` 回 `no new comments`，`wrangler tail` 每分鐘有 `"* * * * *" … Ok`。
- 權杖與密鑰沒有出現在 Git、對話或專案資料夾裡。

## 參考

- 第一次架設：`references/setup-guide.md`（終端機版，含隱私權政策範本）、`references/web-setup-guide.md`（網頁版，國小五年級看得懂）
- 給 ChatGPT／Gemini／Claude 對話用的教練指令：`references/chat-assistant-instructions.md`
- 程式範本：`scripts/worker/`；自我測試：`scripts/selftest.mjs`
