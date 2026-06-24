# AIFF Asset Tracker

一個本機使用的資產、記帳、股票看盤與 LINE 提醒系統。前端是單頁 `index.html`，後端是 Express + SQLite，正式資料存在 `assets.db`，Demo 資料存在 `demo-assets.db`。

## 功能

- Dashboard：總資產、現金/銀行、證券投資、資產配置、當月消費類別佔比、預算水庫進度。
- 快速記帳：日常收入支出、帳戶轉帳。
- 投資紀錄：買進/賣出股票，成本以券商實際交割總金額為準。
- 台股看盤價：優先抓 Fugle 富果即時行情，失敗時依序退回 TWSE MIS 與 TWSE 最新收盤價。
- 分時圖：列出目前持有台股/ETF 的當日 1 分 K，漲紅跌綠，漲跌幅以最新價對昨收計算。
- 流水帳：查看、篩選、修改、刪除歷史紀錄，可依日期區間、帳戶、類型、分類、tag 篩選。
- 帳戶設定：新增、編輯、刪除資產帳戶。
- 記帳類別管理：可在設定頁新增、編輯、刪除收入/支出類別，會同步快速記帳與 LINE。
- 預算水庫：可建立多個預算群組，把多個支出分類綁在同一個月預算額度中控管。
- LINE 推播：
  - 立即傳訊息。
  - 多筆每月固定提醒。
  - 每筆提醒可指定傳給「我」或「老公」。
  - 每筆提醒可單獨啟用、停用、編輯、刪除。
- LINE 快速記帳：
  - 在官方帳號輸入 `1` 紀錄支出，輸入 `2` 紀錄收入。
  - 用按鈕選擇帳戶、分類。
  - 輸入金額後直接寫入系統流水帳。

## Demo 環境

正式頁：

```text
http://localhost:8080/
```

Demo 頁：

```text
http://localhost:8080/demo
```

差異：

- 正式頁使用 `assets.db`。
- Demo 頁使用 `demo-assets.db`。
- Demo 頁 title 與畫面提示會標示 DEMO，避免和正式資料混淆。
- Demo 的 LINE webhook 路徑可用 `/demo/webhook/line`，資料會寫入 demo DB。
- Demo 的 LINE 推播會強制傳給 `me`，避免 demo 時誤傳給其他人。

## 安裝

```bash
npm install
```

## 啟動

```bash
npm start
```

預設會啟動在：

```text
http://localhost:8080
```

也可以指定 port：

```bash
PORT=8080 node server.js
```

## LINE 設定

LINE 相關設定在 `server.js` 開頭：

```js
const LINE_CHANNEL_ACCESS_TOKEN = "...";
const LINE_RECIPIENTS = {
    me: { label: "我", userId: "U..." },
    husband: { label: "老公", userId: "U..." }
};
```

`LINE_CHANNEL_ACCESS_TOKEN` 是官方帳號的 Channel access token。

`LINE_RECIPIENTS` 是收訊息的人。`userId` 必須是 LINE Messaging API 的 `U...` 開頭 userId，不是 LINE 顯示名稱，也不是一般 LINE ID。

## 取得 LINE userId

本系統提供 webhook endpoint：

```text
/webhook/line
/api/webhook
```

建議 LINE Developers 後台填：

```text
https://你的-ngrok網址/webhook/line
```

本機測試可用 ngrok：

```bash
ngrok http 8080
```

設定完成後：

1. 在 LINE Developers 開啟 `Use webhook`。
2. Webhook URL 填 `https://你的-ngrok網址/webhook/line`。
3. 按 `Verify`。
4. 用自己的 LINE 傳訊息給官方帳號。
5. server console 會印出 `U...` userId，官方帳號也會回覆 userId。

## LINE 固定提醒

在前端：

```text
設定 -> 新增固定提醒
```

每筆提醒包含：

- 提醒名稱
- 傳送對象：我 / 老公
- 每月幾號
- 幾點幾分
- 提醒內容
- 啟用狀態

後端每分鐘檢查一次 `line_reminders` 中啟用的提醒。到指定日期與時間會推播 LINE，並用 `last_sent_key` 避免同一分鐘重複傳送。

## LINE 快速記帳

在 LINE 官方帳號輸入：

```text
1
```

代表紀錄支出。

輸入：

```text
2
```

代表紀錄收入。

如果輸入「記帳」，系統會提示你選 `1` 或 `2`。

目前流程是：

```text
輸入 1 或 2 -> 選帳戶 -> 選分類 -> 輸入金額 -> 寫入 transactions 並更新 accounts.balance
```

寫入資料時：

- `transactions.type` 由 LINE 輸入決定：`1` 是 `支出`，`2` 是 `收入`
- `transactions.category` 來自 LINE 選的分類
- `transactions.amount` 來自最後輸入的金額
- `transactions.date` 使用台北時區今天日期
- `transactions.memo` 固定為 `LINE 快速記帳`
- `accounts.balance` 會依照收支型態扣款或加款

LINE 每個使用者目前走到哪一步，存在：

```text
line_tx_sessions
```

所以不同 LINE user 同時記帳時，流程不會互相覆蓋。

### 新增 LINE 分類選項

LINE 快速記帳的分類不是寫死在程式碼常數中，而是讀 SQLite 的 `categories` 資料表。

要新增或修改分類，直接到前端：

```text
設定 -> 新增記帳類別 / 記帳類別管理
```

支出與收入分類都會同步影響：

- 快速記帳頁的分類按鈕。
- LINE 官方帳號快速記帳分類按鈕。
- 預算水庫可勾選的支出分類。

注意：LINE quick reply 一次最多 13 個按鈕。若分類很多，目前後端會取前 12 個分類按鈕；超過時需要再做分頁或多一層分類群組。

### 修改分類名稱

在設定頁編輯分類名稱時，後端會同步更新相關資料：

- `transactions.category`
- `line_tx_sessions.category`
- 舊版單分類預算 `budgets.category`
- 預算水庫 `budget_groups.categories`

例如把 `家庭支出` 改為 `固定支出` 後，舊流水帳也會一起搬到新名稱，避免新增記帳和流水帳出現不同分類。

### 新增 LINE 流程層級

LINE 快速記帳的主要流程在 `server.js` 這幾個 function：

- `promptLineAccountingMode`：提示 `1` 是支出、`2` 是收入。
- `startLineAccounting`：依照 `1` 或 `2` 設定收支型態，並列出帳戶按鈕。
- `askLineCategory`：選完帳戶後，依照收支型態列出分類按鈕。
- `askLineAmount`：選完分類後，要求輸入金額。
- `finishLineAmount`：收到金額後，寫入資料庫並更新帳戶餘額。
- `handleLineWebhook`：接 LINE webhook，判斷使用者按了哪個按鈕或輸入了什麼文字。

如果要增加一層，例如：

```text
輸入 1 或 2 -> 選帳戶 -> 選付款方式 -> 選分類 -> 輸入金額
```

大方向是：

1. 在 `line_tx_sessions` 加欄位，例如 `payment_method TEXT`。
2. 新增一個 function，例如 `askLinePaymentMethod(userId, replyToken, accountId)`。
3. 在該 function 用 `saveLineTxSession` 把 `step` 設成新狀態，例如 `payment_method`。
4. 用 `quickReplyItem` 建立按鈕，按鈕的 `data` 要放新的 action，例如 `action=line_payment&method=信用卡`。
5. 在 `handleLineWebhook` 的 `postback` 區塊新增 `line_payment` 分支。
6. 在 `finishLineAmount` 寫入資料時，把新欄位放進 memo，或先替 `transactions` 加正式欄位後再寫入。

範例按鈕：

```js
quickReplyItem("信用卡", "action=line_payment&method=%E4%BF%A1%E7%94%A8%E5%8D%A1")
```

範例接 webhook：

```js
} else if (action === "line_payment") {
    await askLineCategory(userId, replyToken, session.account_id);
}
```

如果只是想在流程中多問一個「文字輸入」欄位，例如備註，可以讓 session 的 `step` 變成 `memo`，在收到文字訊息時先存 memo，再進到下一步。現在的金額輸入就是同樣模式。

## 台股看盤價與基金記錄

投資買賣支援股票、ETF 與基金。台股/ETF 請輸入台股代號；一般股票是純數字，槓桿/反向/債券 ETF 可能會有英文字尾，例如：

```text
2330
0050
6116
00631L
00632R
00720B
```

基金可以輸入自己的基金代號，例如：

```text
A36004
```

按前端「更新即時行情」時，後端會更新台股/ETF 代號，包含 `00631L` 這種英文字尾 ETF。像 `A36004` 這種字母開頭的基金代號會保留為手動價格，不會被拿去行情 API 查詢。

台股行情來源順序：

1. Fugle 富果行情 API：優先取得盤中即時報價。
2. TWSE MIS：Fugle 沒設定或部分股票讀取失敗時備援。
3. TWSE OpenAPI `STOCK_DAY_ALL`：前兩者都沒有價格時，使用最新收盤價。

Fugle 需要 API key。啟動 server 前設定：

```bash
FUGLE_API_KEY=你的富果APIKEY npm start
```

或：

```bash
FUGLE_API_KEY=你的富果APIKEY node server.js
```

如果沒有設定 `FUGLE_API_KEY`，系統仍會照原本 TWSE 備援流程更新。

## Dashboard

Dashboard 上方顯示：

- 總資產。
- 現金 / 銀行總額。
- 股票當前市值或投資總成本，取決於目前檢視模式。

上方按鈕：

- `更新即時行情`：呼叫後端行情 API，更新股票/ETF 的看盤價。
- `切換成現值評估` / `回歸成本評估`：切換投資部位用看盤價或成本價計算。

原本的手動「刷新」按鈕已移除。若需要重新同步資料，可以直接重新整理瀏覽器頁面；在網頁內新增/修改資料後，系統通常會自動重新讀取資料。

### 當月消費類別佔比

Dashboard 的「當月消費類別佔比」只統計當月日常支出，會排除 `投資出款`，避免投資買進金額壓過一般生活消費。

點擊圓餅圖上的分類色塊會開啟明細視窗，顯示該分類當月流水帳：

- 日期
- 備註/項目
- 金額
- 帳戶

明細視窗底部有 `🔍 前往流水帳進行編輯`，會自動切到流水帳 tab，並套用本月日期區間、支出類型與該分類篩選。

## 預算水庫

預算水庫是「多個支出分類共用一個月預算」的設定。

入口：

```text
設定 -> 預算水庫設定
```

每個預算群組包含：

- 群組名稱，例如 `💋 玩樂與美麗水庫`
- 每月總額度
- 綁定的支出分類清單

Dashboard 會依照每個預算水庫加總當月支出：

```text
執行率 = 群組內所有分類的當月支出合計 / 群組每月總額度
```

進度條顏色：

- 80% 以下：琥珀色。
- 80% 到 100%：橘色。
- 超過 100%：霧紅色，顯示 `⚠️ 群組已超支！`。

## 當日分時圖

前端有一個「分時圖」大 tab，會列出目前持有的台股/ETF 當日 1 分 K 分時線圖。

資料來源：

```text
Fugle 富果行情 API /stock/intraday/candles/{symbol}?timeframe=1
```

這個功能需要 `FUGLE_API_KEY`。基金或非台股代號，例如 `A36004`，不會顯示分時圖，會列在略過清單中。

分時圖右上角的漲跌幅表示「今日漲跌幅」，使用：

```text
(最新價 - 昨收價) / 昨收價
```

若 Fugle 當下沒有回傳昨收價，才會 fallback 用開盤價。顏色採台股習慣：漲紅、跌綠。

假日或非交易時間看到的價格通常會是最近交易日最後價格。

基金價格目前用手動方式記錄：

- 買進/申購時，`成交單價 / 基金淨值` 可填當時淨值。
- `實際交割 / 申購總金額` 填實際扣款總額，系統會用這個計算成本。
- 若基金之後要更新現值，可以再補一個「手動更新標的價格」功能，或串接券商/基金平台 API。

## 投資成本計算

買進股票、ETF 或基金時，系統不以 `成交單價 * 股數` 作為成本，而是以你輸入的：

```text
實際交割 / 申購總金額
```

作為真實成本。這樣可以包含手續費與其他交易成本。

新買進：

```text
成本均價 = 實際交割 / 申購總金額 / 股數或單位數
```

加碼買進：

```text
新成本均價 = (舊持股總成本 + 本次實際交割總金額) / 新總股數
```

## 主要 API

### 帳戶

- `GET /api/accounts`
- `POST /api/accounts`
- `PUT /api/accounts/:id`
- `DELETE /api/accounts/:id`

### 記帳與流水帳

- `GET /api/global-history`
- `POST /api/transactions`
- `POST /api/transfers`
- `PUT /api/history/:r_type/:id`
- `DELETE /api/history/:r_type/:id`
- `GET /api/tags`

### 分類與預算

- `GET /api/categories`
- `POST /api/categories`
- `PUT /api/categories/:id`
- `DELETE /api/categories/:id`
- `GET /api/budgets`：舊版單分類預算，相容保留。
- `POST /api/budgets`：舊版單分類預算，相容保留。
- `GET /api/budget-groups`
- `POST /api/budget-groups`：新增、更新或刪除預算水庫。

### 股票

- `GET /api/stocks`
- `POST /api/stocks`
- `POST /api/stocks/update-market-prices`
- `GET /api/stocks/intraday-charts`

### LINE

- `POST /api/send-line-message`
- `GET /api/line-reminders`
- `POST /api/line-reminders`
- `PUT /api/line-reminders/:id`
- `DELETE /api/line-reminders/:id`
- `POST /webhook/line`
- `POST /api/webhook`

## 資料庫

SQLite 檔案：

```text
assets.db
demo-assets.db
```

主要資料表：

- `accounts`
- `transactions`
- `transfers`
- `stocks`
- `categories`：收入/支出分類設定。
- `transaction_tags`：由備註逗號拆出的 tag。
- `budgets`：舊版單分類預算，保留相容。
- `budget_groups`：預算水庫設定。
- `line_reminders`
- `line_tx_sessions`：LINE 快速記帳流程暫存。
- `notify_settings`：舊版單一提醒設定，保留相容。

## 注意事項

- 請勿將包含金鑰、token 或個人資料的原始碼與資料庫公開上傳。
- 正式部署建議將 LINE 與 Fugle 等金鑰改由環境變數或私有設定檔管理。
- ngrok 網址重開後通常會變，LINE Developers 的 Webhook URL 也要同步更新。
- LINE Push API 需要接收者已加官方帳號好友。
