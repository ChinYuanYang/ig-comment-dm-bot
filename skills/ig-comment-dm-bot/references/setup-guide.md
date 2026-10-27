# 第一次架設：一步一步（給沒寫過程式的人）

> 第一次架設時從頭照做。每一步標示「誰來做」：**使用者**＝要本人按（註冊、密碼、同意條款、授權、發佈）；**AI**＝可以代做。
> 2026-10-26 在 @career.honesttree 實際跑過一次。Meta 後台的按鈕名稱可能會改，找不到時用畫面上的意思對照，不要硬找原字。

## 0. 先確認三件事（AI 問使用者）

1. IG 是**專業帳號**（商業或創作者），而且是**公開**的。私人帳號收不到留言通知。
2. 要送的檔案已經有**下載連結**（自己網站、Google Drive 分享連結都可以），手機點得開。
3. 有一個**測試小號**：沒有加進 App 任何角色，用來扮演一般讀者。最好準備兩個：一個有追蹤、一個沒追蹤。

## 0.5 確認電腦有 Node.js（AI 檢查）

部署工具（wrangler）要靠 Node.js 才能跑。很多新手的電腦沒有裝。

1. **AI**：執行 `node -v`。印出 `v18` 以上的版本號就可以，跳到第 1 步。
2. 找不到指令，或版本低於 18：
   - **使用者**：打開 https://nodejs.org ，下載標示「LTS」的安裝檔，一直按「下一步」裝完。裝完把終端機關掉再打開。
   - **AI**：再跑一次 `node -v` 確認。
3. 使用者不想安裝：改走 `web-setup-guide.md`（網頁版），程式直接貼在 Cloudflare 網頁上，不用安裝任何東西。

## 1. Meta 開發者帳號（使用者）

1. 用**個人 FB 帳號**登入 https://developers.facebook.com 。如果 FB 正在用粉專身分，要先切回個人帳號，粉專身分不能註冊開發者。
2. 右上「立即開始」→ 驗證手機或 Email → 同意開發者條款。

## 2. 建 App（AI 填表，使用者按最後的「建立」）

1. https://developers.facebook.com/apps/ →「建立應用程式」。
2. 名稱：英文，例如 `MyBrand Kit Bot`（不能含 Instagram、IG 等商標字）。
3. 使用案例：篩選「全部」→ 勾「**管理 Instagram 的訊息和內容**」。
4. 商家：選「**我還不想連結商家資產管理組合**」。⚠️ 實測選了商家之後，建立時跳回 Business Suite，App 沒建起來。
5. 總覽頁最下面「建立應用程式」→ **使用者本人按**（等於同意 Meta 條款；可能要重新輸入 FB 密碼）。

## 3. 權限與測試人員

1. **AI**：使用案例 → 自訂 →「含有 Instagram 登入的 API 設定」→ 第 1 步「Add all required permissions」（加入 instagram_business_basic、instagram_business_manage_comments、instagram_business_manage_messages）。
2. **AI**：應用程式角色 → 角色 →「新增用戶」→「Instagram 測試人員」→ 輸入使用者自己的 IG 帳號。
3. **使用者**：IG 網頁 https://www.instagram.com/accounts/manage_access/ →「測試員邀請」→「接受」。

## 4. 拿權杖（使用者登入、AI 收存）

1. API 設定第 2 步「新增帳號」→ 會跳出 IG 授權**小視窗**，常躲在其他視窗後面（Chrome 選單「視窗」找 Instagram）。**使用者**登入並按允許。
2. 帳號列出現後按「產生權杖」→ 勾「我瞭解」→ 按複製。**AI** 用 `pbpaste` 存到 `~/.config/<worker 名稱>/ig_token`（chmod 600），之後清空剪貼簿。權杖不能進 Git、不能貼在對話裡。
3. 驗證：`curl "https://graph.instagram.com/v24.0/me?fields=user_id,username,account_type&access_token=$T"`，記下 `user_id` 填進 `IG_USER_ID`。

## 5. 隱私權政策頁＋發佈 App（最關鍵）

**沒發佈前，App 只看得到「App 角色」的人：一般讀者的留言、私訊全部讀不到（回傳空陣列，不會報錯）。** 發佈不需要商家驗證、也不需要送審，只要一個隱私權政策網址。

1. **AI**：幫使用者做一頁隱私權政策（範本在本檔最後），放在使用者自己的網站、Notion 公開頁或 Google Sites 都可以。要公開的那一下由**使用者**按。
2. **AI**：應用程式設定 → 基本資料：填「隱私政策網址」「資料刪除指示網址」（同一頁即可）、類別選「Messenger Bots for Business」→ Save Changes。
3. **使用者**：左側「發佈」→ 右下「發佈」。（AI 代按會被系統擋：讓 App 上線是使用者本人的決定。）
4. **AI** 驗證：讀任一篇有留言的貼文 `/<media_id>/comments`，有內容才算成功。

## 6. Cloudflare（使用者註冊與授權，AI 部署）

1. **使用者**：https://dash.cloudflare.com/sign-up 免費註冊。
2. **AI**：在 `scripts/worker/` 執行 `npx -y wrangler@4 login --browser=false`（背景執行，輸出寫到檔案），讀出授權網址，在使用者的瀏覽器打開。**使用者**按「Authorize」。⚠️ 有多個 Chrome 設定檔時，要開在登入 Cloudflare 的那一個。
3. **AI**：`npx -y wrangler@4 kv namespace create KV`、`npx -y wrangler@4 d1 create <worker 名稱>-db` → 把兩個 id 填進 wrangler.toml（`__KV_ID__`、`__D1_ID__`）。D1 的表不用建，程式第一次用到會自己建。
4. **AI**：填 wrangler.toml 其他 `__…__`（`HUB_VERIFY` 自己取一個英文字串；`ENABLED` 先留 "false"）。
5. **AI**：設定機密（都用管線餵進去，不要出現在對話裡）：
   - `IG_TOKEN`：第 4 步的權杖
   - `RUN_KEY`：`openssl rand -hex 16`，手動補跑用
   - `APP_SECRET`：基本資料頁「應用程式密鑰」（按顯示會要 FB 密碼，**使用者**輸入）
   - `IG_APP_SECRET`：API 設定頁「Instagram 應用程式密鑰」
   取密鑰：三連點選取文字 → cmd+c → `pbpaste | npx -y wrangler@4 secret put <名稱>` → 清空剪貼簿。（網頁上的「複製」小按鈕有時沒反應，複製後先看長度與開頭確認是對的那把。）
6. **AI**：`npx -y wrangler@4 deploy`。新的 workers.dev 網址要等 1～5 分鐘憑證才生效（curl 報 exit 35 就是還沒好）。

## 7. 讓 Meta 把通知送到程式

1. **AI**：API 設定第 3 步「設定 Webhooks」：回呼網址 `https://<worker>.<子網域>.workers.dev/webhook`、驗證權杖填 `HUB_VERIFY` 的值 →「驗證並儲存」。⚠️ 欄位常被 Chrome 自動填進 Email，先全選刪掉再打。
   - ⚠️ **一定要在這個後台頁面設**。用 API 對 Meta App 編號設 `/subscriptions`，回傳 success 但通知不會來。
2. 確認欄位清單裡 **comments、messages、messaging_postbacks** 都是「已訂閱」。（官方文件寫 comments 要 Advanced Access；實測 App 發佈後 Standard Access 就收得到，幾秒內送達。）
3. **AI**：替帳號訂閱：`POST https://graph.instagram.com/v24.0/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=$T`。
   - ⚠️ 讀者的回覆要發生在**這一步之後**才算數。之前回的會被當成超過 24 小時，傳訊息報錯 code 10、subcode 2534022「這則訊息並未在允許的期間內傳送」→ 請讀者再回一次即可。

## 8. 用小號測（總開關關著）

1. 小號私訊一句話給使用者帳號 → 從 `/me/conversations?platform=instagram&fields=participants` 找出小號的 IGSID，填進 `TEST_USERS` → 重新 deploy。
2. 看紀錄：`npx -y wrangler@4 tail --format pretty > 紀錄檔`（背景執行）。
3. 小號在**最新 3 篇**留言關鍵字 → 幾秒內應該收到私訊＋留言底下的公開回覆。
4. 沒追蹤的小號：回一句 → 收到兩顆按鈕 → 先按「我追蹤好了」→「還沒看到」→ 追蹤後再按 → 收到檔案。
5. 卡住時先 `curl "https://<worker>/run?key=<RUN_KEY>"` 手動跑一次，看回傳的紀錄。

## 9. 上線

使用者點頭後：`ENABLED = "true"` → deploy → 用 /run 確認回 `no new comments`（代表沒有誤回舊留言）。


## 10. 出問題寄信（選配，建議做）

1. **使用者**：用想收信的 Google 帳號打開 https://script.new ，**AI** 告訴他貼上 `references/alert-mailer.gs`、把 `TO` 換成他的信箱。
2. **使用者**：部署 → 新增部署作業 → 網頁應用程式（執行身分「我」、存取「所有人」）→ 授權（「未驗證的應用程式」按進階 → 前往）。
3. **AI**：拿到網址後 `printf '%s' '<網址>' | npx -y wrangler@4 secret put ALERT_URL`，再打開 `/alert-test?key=<RUN_KEY>` 確認收得到信。
4. 之後遇到 IG 錯誤 190／200／368／限流，或資料庫（KV／D1）額度用完、程式出錯，會寄信，同類 1 小時一封。

補發停擺期間漏掉的人：`/run?key=<RUN_KEY>&minutes=<分鐘>&delay=6000&limit=8`，多跑幾次直到回 `no new comments`。慢慢補，避免又被當成異常活動。

---

## 隱私權政策範本（改成使用者自己的名字與信箱）

```
最後更新：YYYY 年 M 月 D 日

這份說明適用於〈品牌名〉（Instagram @帳號）的 IG 私訊小幫手。當你在〈品牌名〉的貼文留言索取檔案時，小幫手會用私訊把檔案連結傳給你。

## 我們會用到哪些資料
- 你的 Instagram 帳號編號與使用者名稱
- 你在〈品牌名〉貼文底下的留言內容
- 你傳給〈品牌名〉的私訊內容
- 你是否追蹤〈品牌名〉

## 用在哪裡
只用來判斷你是不是在索取檔案，並把檔案連結私訊給你。不會拿來投放廣告，也不會賣給或分享給任何第三方。

## 保存多久
小幫手只保留「已經傳過檔案給誰」的紀錄（帳號編號與時間），避免重複傳送；紀錄最多保存 90 天後刪除。

## 想刪除資料或有問題
寫信到〈信箱〉，註明你的 Instagram 帳號，我們會在 7 天內刪除與你有關的紀錄並回覆你。
```
