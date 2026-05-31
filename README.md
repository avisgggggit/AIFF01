# AIFF Asset Tracker

一個本機使用的資產、記帳、股票看盤與 LINE 提醒系統。前端是單頁 `index.html`，後端是 Express + SQLite，資料存在 `assets.db`。

## 功能

- 資產總覽：現金/銀行、證券投資、總資產。
- 快速記帳：日常收入支出、帳戶轉帳。
- 投資紀錄：買進/賣出股票，成本以券商實際交割總金額為準。
- 台股看盤價：優先抓 TWSE MIS 看盤價，失敗時退回 TWSE 最新收盤價。
- 流水帳：查看、修改、刪除歷史紀錄。
- 帳戶設定：新增、編輯、刪除資產帳戶。
- LINE 推播：
  - 立即傳訊息。
  - 多筆每月固定提醒。
  - 每筆提醒可指定傳給「我」或「老公」。
  - 每筆提醒可單獨啟用、停用、編輯、刪除。

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

## 股票看盤價

按前端「更新看盤價」時，後端會呼叫：

- TWSE MIS：盤中看盤價。
- TWSE OpenAPI `STOCK_DAY_ALL`：MIS 失敗時使用最新收盤價。

資料會寫入股票庫存的：

- `market_price`
- `market_price_source`
- `market_price_date`
- `market_price_time`

假日或非交易時間看到的價格通常會是最近交易日最後價格。

## 投資成本計算

買進股票時，系統不以 `成交單價 * 股數` 作為成本，而是以你輸入的：

```text
券商 App 實際交割總金額
```

作為真實成本。這樣可以包含手續費與其他交易成本。

新買進：

```text
成本均價 = 實際交割總金額 / 股數
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

### 股票

- `GET /api/stocks`
- `POST /api/stocks`
- `POST /api/stocks/update-market-prices`

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
```

主要資料表：

- `accounts`
- `transactions`
- `transfers`
- `stocks`
- `line_reminders`
- `notify_settings`：舊版單一提醒設定，保留相容。

## 注意事項

- `server.js` 目前包含 LINE token，請不要公開上傳到公開 repo。
- ngrok 網址重開後通常會變，LINE Developers 的 Webhook URL 也要同步更新。
- LINE Push API 需要接收者已加官方帳號好友。
