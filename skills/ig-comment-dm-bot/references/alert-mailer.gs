// IG 留言自動私訊小幫手：出問題寄信給你（Google Apps Script，選配）
// 用法：到 https://script.new 建新專案 → 全部貼上 → 把下面 TO 換成你的信箱 → 存檔
//      部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」、誰可以存取「所有人」→ 部署 → 授權
//      複製「網頁應用程式網址」，存進 Cloudflare 的 Secret：ALERT_URL
// 網址本身是一長串猜不到的亂碼；而且這支程式只會寄到你自己的信箱，別人拿到網址也只能寄信給你
const TO = 'you@example.com';

function doPost(e) {
  const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  MailApp.sendEmail(TO, '【IG 小幫手】' + String(d.subject || '有狀況').slice(0, 80), String(d.body || '').slice(0, 3000));
  return ContentService.createTextOutput('ok');
}
