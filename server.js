const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const https = require("https"); // ✨ 內建神仙套件，保證免安裝、絕對不失聯！

const app = express();
const PORT = process.env.PORT || 8080; 
const db = new sqlite3.Database(path.join(__dirname, "assets.db"));

// ==========================================
// 🔑 LINE 密碼填寫特區 (已經幫妳把Token鎖死在這裡，網頁不用再看到了)
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = "DavSzTF3CHtq9KElIv9N+qBnI1vRfk3to1cyLJiJxavnmbmUaPziu1HVIuyLu3G/N6yImWVK3/Ek9evgTgCHgD8kWqP9EYLKkG6d4GWbvKVGXER/8/aANoukWp5JzqnG+PGUZ7Bj3rIvFN7berOpTQdB04t89/1O/w1cDnyilFU=";
const MY_LINE_USER_ID = "Uc56ad3eb8804726b20ed6e93323e6d4f"; 
const LINE_RECIPIENTS = {
    me: { label: "我", userId: "Uc56ad3eb8804726b20ed6e93323e6d4f" },
    husband: { label: "老公", userId: "U704dbfdc13c0bfbbf4496c614bb0c22b" }
};
// ==========================================

app.use(express.json());
app.use(express.static(__dirname));

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
    });
}
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
}

function toTwseStockCode(stockCode) {
    const rawCode = String(stockCode || "").trim().toUpperCase();
    if (!rawCode) return null;

    const numericCodeMatch = rawCode.match(/[0-9]+/);
    return numericCodeMatch ? numericCodeMatch[0] : null;
}

function resolveLineRecipient(recipient = "me") {
    return LINE_RECIPIENTS[recipient] || LINE_RECIPIENTS.me;
}

function taipeiDateString() {
    const twTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    return `${twTime.getFullYear()}-${String(twTime.getMonth() + 1).padStart(2, "0")}-${String(twTime.getDate()).padStart(2, "0")}`;
}

const LINE_TX_CATEGORIES = {
    "支出": ["餐飲食宿", "購物治裝", "生活雜費", "保險醫療", "交通出行", "休閒娛樂", "投資出款", "其他支出"],
    "收入": ["薪資收入", "投資獲利", "獎金紅包", "其他收入"]
};

function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                ...headers
            }
        };
        https.get(url, options, (response) => {
            let data = "";
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("解析股價資料失敗"));
                }
            });
        }).on("error", reject);
    });
}

function parsePrice(value) {
    const price = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(price) && price > 0 ? price : null;
}

function formatTwseDate(rawDate) {
    const value = String(rawDate || "");
    if (/^[0-9]{8}$/.test(value)) {
        return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    }
    if (/^[0-9]{7}$/.test(value)) {
        const year = Number(value.slice(0, 3)) + 1911;
        return `${year}-${value.slice(3, 5)}-${value.slice(5, 7)}`;
    }
    return value;
}

async function fetchTwseRealtimePrices(stockCodes) {
    const channels = stockCodes.flatMap(s => [`tse_${s.twseCode}.tw`, `otc_${s.twseCode}.tw`]);
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join("|"))}&json=1&delay=0&_=${Date.now()}`;
    
    const data = await fetchJson(url, { Referer: "https://mis.twse.com.tw/stock/index.jsp" });
    const priceMap = {};
    
    (data.msgArray || []).forEach(row => {
        const price = parsePrice(row.z) || parsePrice(row.pz) || parsePrice(row.y);
        if (row.c && price) {
            priceMap[row.c] = {
                price,
                source: "TWSE MIS 看盤價",
                quoteDate: formatTwseDate(row.d),
                quoteTime: row.t || row.ot || ""
            };
        }
    });
    return priceMap;
}

async function fetchTwseClosingPrices() {
    const twseData = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
    const priceMap = {};
    twseData.forEach(row => {
        const price = parsePrice(row.ClosingPrice);
        if (row.Code && price) {
            priceMap[row.Code] = {
                price,
                source: "TWSE 最新收盤價",
                quoteDate: formatTwseDate(row.Date),
                quoteTime: "收盤"
            };
        }
    });
    return priceMap;
}

// 🚀 LINE Messaging API 專用精緻 Flex Message 發送功能 (法式燕麥奶茶色卡片)
function sendLineFlexMessage(userId, title, content, highlightColor = "#b59f86") {
    return new Promise((resolve, reject) => {
        if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) {
            reject(new Error("尚未設定 LINE Channel Access Token 或接收者 ID"));
            return;
        }

        const payload = JSON.stringify({
            to: userId,
            messages: [{
                type: "flex",
                altText: `【資產大腦通知】${title}`,
                contents: {
                    type: "bubble",
                    size: "mega",
                    styles: { header: { backgroundColor: "#fbfaf8" }, body: { backgroundColor: "#ffffff" } },
                    header: {
                        type: "box", layout: "vertical", paddingAll: "20px",
                        contents: [{ type: "text", text: title, weight: "bold", size: "lg", color: highlightColor }]
                    },
                    body: {
                        type: "box", layout: "vertical", paddingAll: "20px",
                        contents: [
                            { type: "text", text: content, wrap: true, size: "sm", color: "#443e38" },
                            { type: "separator", margin: "xl", color: "#f0ede9" },
                            { type: "text", text: "💡 來自妳心愛的資產管理系統提醒 💋", size: "xxs", color: "#b5a89e", margin: "md" }
                        ]
                    }
                }
            }]
        });

        const options = {
            hostname: "api.line.me",
            port: 443,
            path: "/v2/bot/message/push",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (lineRes) => {
            let data = "";
            lineRes.on("data", (chunk) => data += chunk);
            lineRes.on("end", () => {
                console.log("✨ LINE 推播回應：", data || lineRes.statusCode);
                if (lineRes.statusCode >= 200 && lineRes.statusCode < 300) {
                    resolve({ status: lineRes.statusCode, body: data });
                } else {
                    reject(new Error(data || `LINE API 回應 ${lineRes.statusCode}`));
                }
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function replyLineMessages(replyToken, messages) {
    return new Promise((resolve, reject) => {
        if (!LINE_CHANNEL_ACCESS_TOKEN || !replyToken) {
            reject(new Error("尚未設定 LINE Channel Access Token 或 replyToken"));
            return;
        }

        const payload = JSON.stringify({
            replyToken,
            messages
        });

        const options = {
            hostname: "api.line.me",
            port: 443,
            path: "/v2/bot/message/reply",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (lineRes) => {
            let data = "";
            lineRes.on("data", (chunk) => data += chunk);
            lineRes.on("end", () => {
                if (lineRes.statusCode >= 200 && lineRes.statusCode < 300) {
                    resolve({ status: lineRes.statusCode, body: data });
                } else {
                    reject(new Error(data || `LINE Reply API 回應 ${lineRes.statusCode}`));
                }
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function replyLineText(replyToken, text) {
    return replyLineMessages(replyToken, [{ type: "text", text }]);
}

function quickReplyItem(label, data) {
    const shortLabel = String(label).slice(0, 20);
    return {
        type: "action",
        action: {
            type: "postback",
            label: shortLabel,
            data,
            displayText: shortLabel
        }
    };
}

function replyLineQuickReply(replyToken, text, items) {
    return replyLineMessages(replyToken, [{
        type: "text",
        text,
        quickReply: { items: items.slice(0, 13) }
    }]);
}

async function getLineTxSession(userId) {
    const rows = await all("SELECT * FROM line_tx_sessions WHERE user_id = ?", [userId]);
    return rows[0] || null;
}

async function saveLineTxSession(userId, fields) {
    const current = await getLineTxSession(userId);
    const next = {
        step: current?.step || "",
        account_id: current?.account_id || null,
        tx_type: current?.tx_type || null,
        category: current?.category || null,
        ...fields
    };

    await run(`
        INSERT INTO line_tx_sessions (user_id, step, account_id, tx_type, category, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
            step = excluded.step,
            account_id = excluded.account_id,
            tx_type = excluded.tx_type,
            category = excluded.category,
            updated_at = datetime('now')
    `, [userId, next.step, next.account_id, next.tx_type, next.category]);
}

async function clearLineTxSession(userId) {
    await run("DELETE FROM line_tx_sessions WHERE user_id = ?", [userId]);
}

async function startLineAccounting(userId, replyToken) {
    await clearLineTxSession(userId);
    const accounts = await all("SELECT id, name, balance FROM accounts ORDER BY type, id DESC");
    if (accounts.length === 0) {
        return replyLineText(replyToken, "目前還沒有帳戶，請先到系統的「設定」新增帳戶。");
    }

    await saveLineTxSession(userId, { step: "account" });
    const items = accounts.map(account => quickReplyItem(account.name, `action=line_account&account_id=${account.id}`));
    return replyLineQuickReply(replyToken, "請選擇要記帳的帳戶：", items);
}

async function askLineExpenseCategory(userId, replyToken, accountId) {
    const account = (await all("SELECT id, name FROM accounts WHERE id = ?", [accountId]))[0];
    if (!account) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "找不到這個帳戶，請重新輸入「記帳」再試一次。");
    }

    await saveLineTxSession(userId, { step: "category", account_id: account.id, tx_type: "支出", category: null });
    const items = LINE_TX_CATEGORIES["支出"].map(category =>
        quickReplyItem(category, `action=line_category&category=${encodeURIComponent(category)}`)
    );
    items.push(quickReplyItem("取消", "action=line_cancel"));
    return replyLineQuickReply(replyToken, `帳戶：${account.name}\n請選擇支出分類：`, items);
}

async function askLineAmount(userId, replyToken, category) {
    const session = await getLineTxSession(userId);
    if (!session?.account_id || !session?.tx_type) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "記帳流程已中斷，請重新輸入「記帳」。");
    }

    await saveLineTxSession(userId, { step: "amount", category });
    return replyLineText(replyToken, `分類：${category}\n請輸入交易金額，例如 120。\n要取消請輸入「取消」。`);
}

async function finishLineAmount(userId, replyToken, text) {
    const session = await getLineTxSession(userId);
    if (!session || session.step !== "amount" || !session.account_id || !session.tx_type || !session.category) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "記帳流程已中斷，請重新輸入「記帳」。");
    }

    const amount = Number(String(text).replace(/[$,，\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
        return replyLineText(replyToken, "請輸入正確金額，例如 120。要取消請輸入「取消」。");
    }

    const account = (await all("SELECT id, name FROM accounts WHERE id = ?", [session.account_id]))[0];
    if (!account) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "找不到這個帳戶，請重新輸入「記帳」再試一次。");
    }

    try {
        await run("BEGIN TRANSACTION");
        await run(
            "INSERT INTO transactions (account_id, type, category, amount, date, memo) VALUES (?, ?, ?, ?, ?, ?)",
            [session.account_id, session.tx_type, session.category, amount, taipeiDateString(), "LINE 快速記帳"]
        );
        await run(
            "UPDATE accounts SET balance = balance + ? WHERE id = ?",
            [session.tx_type === "收入" ? amount : -amount, session.account_id]
        );
        await run("COMMIT");
        await clearLineTxSession(userId);

        const sign = session.tx_type === "收入" ? "+" : "-";
        return replyLineText(
            replyToken,
            `已完成記帳：\n${account.name}\n${session.tx_type} / ${session.category}\n${sign}$${amount.toLocaleString("zh-TW")}`
        );
    } catch (err) {
        await run("ROLLBACK").catch(() => {});
        throw err;
    }
}

async function handleLineWebhook(req, res) {
    const events = req.body.events || [];
    res.sendStatus(200);

    for (const event of events) {
        const userId = event.source?.userId;
        if (!userId) continue;
        const replyToken = event.replyToken;

        console.log("======================================");
        console.log("💖 抓到 LINE User ID 囉！");
        console.log("👉 " + userId);
        console.log("======================================");

        if (!replyToken) continue;

        try {
            if (event.type === "postback") {
                const params = new URLSearchParams(event.postback?.data || "");
                const action = params.get("action");

                if (action === "line_start") {
                    await startLineAccounting(userId, replyToken);
                } else if (action === "line_account") {
                    await askLineExpenseCategory(userId, replyToken, Number(params.get("account_id")));
                } else if (action === "line_type") {
                    const session = await getLineTxSession(userId);
                    if (session?.account_id) {
                        await askLineExpenseCategory(userId, replyToken, session.account_id);
                    } else {
                        await startLineAccounting(userId, replyToken);
                    }
                } else if (action === "line_category") {
                    await askLineAmount(userId, replyToken, params.get("category"));
                } else if (action === "line_cancel") {
                    await clearLineTxSession(userId);
                    await replyLineText(replyToken, "已取消 LINE 快速記帳。");
                }
                continue;
            }

            if (event.type === "message" && event.message?.type === "text") {
                const text = String(event.message.text || "").trim();
                if (text === "取消") {
                    await clearLineTxSession(userId);
                    await replyLineText(replyToken, "已取消 LINE 快速記帳。");
                    continue;
                }

                const session = await getLineTxSession(userId);
                if (session?.step === "amount") {
                    await finishLineAmount(userId, replyToken, text);
                    continue;
                }

                if (text === "記帳" || text === "快速記帳" || text.includes("記帳")) {
                    await startLineAccounting(userId, replyToken);
                    continue;
                }

                await replyLineQuickReply(replyToken, `傳「記帳」可以開始快速記一筆收支。\n\n你的 LINE userId：\n${userId}`, [
                    quickReplyItem("開始記帳", "action=line_start")
                ]);
            }
        } catch (e) {
            console.error("❌ LINE webhook 處理失敗:", e.message);
            await replyLineText(replyToken, "LINE 快速記帳暫時失敗，請稍後再試。")
                .catch(err => console.error("❌ LINE webhook 回覆失敗:", err.message));
        }
    }
}

// 初始化資料庫
db.serialize(async () => {
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            balance REAL NOT NULL DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            memo TEXT,
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_account_id INTEGER NOT NULL,
            to_account_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            memo TEXT,
            FOREIGN KEY(from_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY(to_account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS stocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            stock_code TEXT NOT NULL,
            shares REAL NOT NULL,
            cost REAL NOT NULL,
            market_price REAL,
            market_price_source TEXT,
            market_price_date TEXT,
            market_price_time TEXT,
            date TEXT,
            UNIQUE(account_id, stock_code),
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    // ✨ 建立 LINE 月定時推播設定表
    db.run(`CREATE TABLE IF NOT EXISTS notify_settings (id INTEGER PRIMARY KEY CHECK (id = 1), push_time TEXT DEFAULT '21:30', credit_card_day INTEGER DEFAULT 25, monthly_enabled INTEGER DEFAULT 1, daily_msg TEXT DEFAULT '', card_msg TEXT DEFAULT '')`);
    db.run(`INSERT OR IGNORE INTO notify_settings (id, push_time, credit_card_day, monthly_enabled, daily_msg, card_msg) VALUES (1, '21:30', 25, 1, '', '重要通知！今天記得檢查信用卡費並繳清唷！💳')`);
    db.run(`CREATE TABLE IF NOT EXISTS line_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, day_of_month INTEGER NOT NULL, push_time TEXT NOT NULL, message TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT 'me', enabled INTEGER NOT NULL DEFAULT 1, last_sent_key TEXT)`);
    db.run(`
        CREATE TABLE IF NOT EXISTS line_tx_sessions (
            user_id TEXT PRIMARY KEY,
            step TEXT NOT NULL,
            account_id INTEGER,
            tx_type TEXT,
            category TEXT,
            updated_at TEXT
        )
    `);

    db.all("PRAGMA table_info(notify_settings)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'monthly_enabled')) {
            db.run("ALTER TABLE notify_settings ADD COLUMN monthly_enabled INTEGER DEFAULT 1");
        }
    });
    db.get("SELECT COUNT(*) as count FROM line_reminders", (err, row) => {
        if (err || !row || row.count > 0) return;
        db.get("SELECT * FROM notify_settings WHERE id = 1", (settingsErr, settings) => {
            if (settingsErr || !settings || !settings.card_msg) return;
            db.run(
                "INSERT INTO line_reminders (name, day_of_month, push_time, message, recipient, enabled) VALUES (?, ?, ?, ?, ?, ?)",
                ["信用卡費提醒", settings.credit_card_day || 25, settings.push_time || "21:30", settings.card_msg, "me", Number(settings.monthly_enabled ?? 1)]
            );
        });
    });

    db.all("PRAGMA table_info(line_reminders)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'recipient')) {
            db.run("ALTER TABLE line_reminders ADD COLUMN recipient TEXT NOT NULL DEFAULT 'me'");
        }
    });

    db.all("PRAGMA table_info(transactions)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'stock_ref_id')) {
            db.run("ALTER TABLE transactions ADD COLUMN stock_ref_id INTEGER");
        }
    });

    db.all("PRAGMA table_info(stocks)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'market_price')) {
            db.run("ALTER TABLE stocks ADD COLUMN market_price REAL");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price_source')) {
            db.run("ALTER TABLE stocks ADD COLUMN market_price_source TEXT");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price_date')) {
            db.run("ALTER TABLE stocks ADD COLUMN market_price_date TEXT");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price_time')) {
            db.run("ALTER TABLE stocks ADD COLUMN market_price_time TEXT");
        }
    });

    console.log("🔒 完美版看盤價資產大腦配置完畢！");
});

// 🎯 核心定時排程（每分鐘起來檢查有沒有到設定時間）
setInterval(() => {
    try {
        const twTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Taipei"}));
        const todayDate = twTime.getDate(); 
        const currentTime = `${String(twTime.getHours()).padStart(2, '0')}:${String(twTime.getMinutes()).padStart(2, '0')}`;
        const scheduleKey = `${twTime.getFullYear()}-${twTime.getMonth() + 1}-${todayDate}-${currentTime}`;

        db.all("SELECT * FROM line_reminders WHERE enabled = 1 AND day_of_month = ? AND push_time = ?", [todayDate, currentTime], async (err, reminders) => {
            if (err || !reminders) return;

            for (const reminder of reminders) {
                const reminderKey = `${reminder.id}-${scheduleKey}`;
                if (reminder.last_sent_key === reminderKey) continue;
                await run("UPDATE line_reminders SET last_sent_key = ? WHERE id = ?", [reminderKey, reminder.id]).catch(() => {});
                const recipient = resolveLineRecipient(reminder.recipient);
                await sendLineFlexMessage(recipient.userId, `🚨 ${reminder.name}`, reminder.message, "#8c755e")
                    .catch(e => console.error("❌ LINE 月定時推播失敗:", e.message));
            }
        });
    } catch (e) { console.error("排程執行失敗:", e); }
}, 60 * 1000);

// 🔔 LINE 固定提醒清單 API
function normalizeReminderBody(body) {
    const name = String(body.name || "").trim();
    const day = Number(body.day_of_month);
    const pushTime = String(body.push_time || "").trim();
    const message = String(body.message || "").trim();
    const recipient = LINE_RECIPIENTS[body.recipient] ? body.recipient : "me";
    const enabled = body.enabled ? 1 : 0;
    if (!name) throw new Error("請輸入提醒名稱");
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("每月日期請輸入 1 到 31");
    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(pushTime)) throw new Error("請選擇正確提醒時間");
    if (!message) throw new Error("請輸入提醒內容");
    return { name, day, pushTime, message, recipient, enabled };
}

app.get("/api/line-reminders", async (req, res) => {
    try {
        res.json(await all("SELECT * FROM line_reminders ORDER BY day_of_month, push_time, id"));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/line-reminders", async (req, res) => {
    try {
        const r = normalizeReminderBody(req.body);
        await run("INSERT INTO line_reminders (name, day_of_month, push_time, message, recipient, enabled) VALUES (?, ?, ?, ?, ?, ?)", [r.name, r.day, r.pushTime, r.message, r.recipient, r.enabled]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/line-reminders/:id", async (req, res) => {
    try {
        const r = normalizeReminderBody(req.body);
        await run("UPDATE line_reminders SET name = ?, day_of_month = ?, push_time = ?, message = ?, recipient = ?, enabled = ? WHERE id = ?", [r.name, r.day, r.pushTime, r.message, r.recipient, r.enabled, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/line-reminders/:id", async (req, res) => {
    try {
        await run("DELETE FROM line_reminders WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 舊 API 保留給舊前端，不再作為主要功能
app.get("/api/notify-settings", (req, res) => {
    db.get("SELECT * FROM notify_settings WHERE id = 1", (err, row) => { 
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { push_time: '21:30', credit_card_day: 25, monthly_enabled: 1, card_msg: '' }); 
    });
});

app.post("/api/send-line-message", async (req, res) => {
    try {
        const message = String(req.body.message || "").trim();
        const recipient = resolveLineRecipient(req.body.recipient);
        if (!message) return res.status(400).json({ error: "訊息不能空白" });
        await sendLineFlexMessage(recipient.userId, `💬 即時資產提醒給${recipient.label}`, message, "#b59f86");
        res.json({ success: true });
    } catch (err) {
        console.error("❌ LINE 即時推播失敗:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 📈 股票即時看盤價大對接
app.post("/api/stocks/update-market-prices", async (req, res) => {
    try {
        console.log("🚀 正在連線 TWSE MIS 獲取看盤價...");
        const currentStocks = await all("SELECT DISTINCT stock_code FROM stocks");
        if (currentStocks.length === 0) {
            return res.json({ success: true, updated: 0 });
        }

        const stockCodes = currentStocks
            .map(s => ({
                stockCode: s.stock_code,
                twseCode: toTwseStockCode(s.stock_code)
            }))
            .filter(s => s.twseCode);

        if (stockCodes.length === 0) {
            return res.json({ success: true, updated: 0 });
        }

        let source = "TWSE MIS 看盤價";
        let priceMap = {};
        try {
            priceMap = await fetchTwseRealtimePrices(stockCodes);
        } catch (err) {
            console.warn("⚠️ TWSE MIS 看盤價讀取失敗，改用最新收盤價:", err.message);
        }

        if (Object.keys(priceMap).length === 0) {
            priceMap = await fetchTwseClosingPrices();
            source = "TWSE 最新收盤價";
        }

        await run("BEGIN TRANSACTION");
        let updateCount = 0;
        for (let s of stockCodes) {
            const quote = priceMap[s.twseCode];
            if (quote) {
                await run(`
                    UPDATE stocks 
                    SET market_price = ?, market_price_source = ?, market_price_date = ?, market_price_time = ?
                    WHERE stock_code = ?
                `, [quote.price, quote.source, quote.quoteDate, quote.quoteTime, s.stockCode]);
                updateCount++;
            }
        }
        await run("COMMIT");
        console.log(`✨ 成功幫妳把 ${updateCount} 檔持股更新到 ${source}！`);
        res.json({ success: true, updated: updateCount, source });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        console.error("❌ TWSE 看盤價更新失敗:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 🏦 帳戶管理 API
app.post("/api/accounts", async (req, res) => {
    try {
        const { name, type, balance = 0 } = req.body;
        let mappedType = type;
        if (type.includes("現金")) mappedType = "身上現金";
        if (type.includes("銀行") || type.includes("戶頭")) mappedType = "銀行戶頭";
        if (type.includes("證券") || type.includes("投資")) mappedType = "證券投資";

        const result = await run("INSERT INTO accounts (name, type, balance) VALUES (?, ?, ?)", [name, mappedType, Number(balance)]);
        res.status(201).json({ id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/accounts", async (req, res) => {
    try {
        res.json(await all("SELECT * FROM accounts ORDER BY type, id DESC"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/accounts/:id", async (req, res) => {
    try {
        await run("UPDATE accounts SET name = ?, balance = ? WHERE id = ?", [req.body.name, Number(req.body.balance), req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/accounts/:id", async (req, res) => {
    try {
        await run("PRAGMA foreign_keys = ON");
        await run("DELETE FROM accounts WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 📜 全域歷史明細
app.get("/api/global-history", async (req, res) => {
    try {
        const txs = await all(`
            SELECT id, 'transaction' as r_type, type, category, amount, date, memo,
                   (SELECT name FROM accounts WHERE id=account_id) as account_name
            FROM transactions
        `);
        const tfOut = await all(`
            SELECT t.id, 'transfer_out' as r_type, '轉出' as type, a2.name as category, t.amount, t.date, t.memo,
                   a1.name as account_name
            FROM transfers t
            JOIN accounts a1 ON t.from_account_id = a1.id
            JOIN accounts a2 ON t.to_account_id = a2.id
        `);
        const tfIn = await all(`
            SELECT t.id, 'transfer_in' as r_type, '轉入' as type, a1.name as category, t.amount, t.date, t.memo,
                   a2.name as account_name
            FROM transfers t
            JOIN accounts a1 ON t.from_account_id = a1.id
            JOIN accounts a2 ON t.to_account_id = a2.id
        `);

        const history = [...txs, ...tfOut, ...tfIn].sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 💸 交易收支 API
app.post("/api/transactions", async (req, res) => {
    try {
        const { account_id, type, category, amount, date, memo } = req.body;
        await run("BEGIN TRANSACTION");
        await run("INSERT INTO transactions (account_id, type, category, amount, date, memo) VALUES (?, ?, ?, ?, ?, ?)", [account_id, type, category, Number(amount), date, memo]);
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [type === "收入" ? Number(amount) : -Number(amount), account_id]);
        await run("COMMIT");
        res.status(201).json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 🔄 帳戶轉帳 API
app.post("/api/transfers", async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount, date, memo } = req.body;
        if (from_account_id === to_account_id) return res.status(400).json({ error: "不能轉帳給同一個帳戶" });

        await run("BEGIN TRANSACTION");
        await run("INSERT INTO transfers (from_account_id, to_account_id, amount, date, memo) VALUES (?, ?, ?, ?, ?)", [from_account_id, to_account_id, Number(amount), date, memo]);
        await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [Number(amount), from_account_id]);
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [Number(amount), to_account_id]);
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 📈 股票倉位 API
app.post("/api/stocks", async (req, res) => {
    try {
        const { account_id, stock_code, type, shares, price, total_cost, date } = req.body;
        const qty = Number(shares);
        const totalAmount = Math.round(Number(total_cost));
        const inputPrice = Number(price);
        const inputCost = totalAmount / qty;
        const targetDate = date || new Date().toISOString().slice(0, 10);

        await run("BEGIN TRANSACTION");
        const rows = await all("SELECT * FROM stocks WHERE account_id = ? AND stock_code = ?", [account_id, stock_code]);
        const stock = rows[0];
        let stockId = stock ? stock.id : null;

        if (type === "買進") {
            if (stock) {
                const nextShares = stock.shares + qty;
                const nextCost = ((stock.shares * stock.cost) + totalAmount) / nextShares;
                await run("UPDATE stocks SET shares = ?, cost = ?, date = ? WHERE id = ?", [nextShares, nextCost, targetDate, stock.id]);
            } else {
                const insRes = await run("INSERT INTO stocks (account_id, stock_code, shares, cost, market_price, date) VALUES (?, ?, ?, ?, ?, ?)", [account_id, stock_code, qty, inputCost, inputPrice, targetDate]);
                stockId = insRes.lastID;
            }
            await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [totalAmount, account_id]);
            await run("INSERT INTO transactions (account_id, type, category, amount, date, memo, stock_ref_id) VALUES (?, '支出', '投資出款', ?, ?, ?, ?)", [account_id, totalAmount, targetDate, `買入 ${stock_code} (${qty}股/市價${price})`, stockId]);
        } else {
            if (!stock || stock.shares < qty) {
                await run("ROLLBACK");
                return res.status(400).json({ error: "持股庫存不足" });
            }
            if (stock.shares === qty) {
                await run("DELETE FROM stocks WHERE id = ?", [stock.id]);
            } else {
                await run("UPDATE stocks SET shares = ?, date = ? WHERE id = ?", [stock.shares - qty, targetDate, stock.id]);
            }
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [totalAmount, account_id]);
            await run("INSERT INTO transactions (account_id, type, category, amount, date, memo, stock_ref_id) VALUES (?, '收入', '投資獲利', ?, ?, ?, ?)", [account_id, totalAmount, targetDate, `賣出 ${stock_code} (${qty}股/市價${price})`, stock.id]);
        }
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 📜 歷史帳目修改 API
app.put("/api/history/:r_type/:id", async (req, res) => {
    try {
        const { r_type, id } = req.params;
        const { date, category, memo, amount } = req.body;
        const newAmt = Number(amount);

        await run("BEGIN TRANSACTION");
        if (r_type === 'transaction') {
            const old = (await all("SELECT * FROM transactions WHERE id = ?", [id]))[0];
            const oldDiff = old.type === "收入" ? -old.amount : old.amount;
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [oldDiff, old.account_id]);

            const newDiff = old.type === "收入" ? newAmt : -newAmt;
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [newDiff, old.account_id]);
            await run("UPDATE transactions SET date=?, category=?, memo=?, amount=? WHERE id=?", [date, category, memo, newAmt, id]);
        } else {
            const old = (await all("SELECT * FROM transfers WHERE id = ?", [id]))[0];
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [old.amount, old.from_account_id]);
            await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [old.amount, old.to_account_id]);

            await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [newAmt, old.from_account_id]);
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [newAmt, old.to_account_id]);
            await run("UPDATE transfers SET date=?, memo=?, amount=? WHERE id=?", [date, memo, newAmt, id]);
        }
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 🗑️ 歷史帳目銷毀與餘額回溯 API
app.delete("/api/history/:r_type/:id", async (req, res) => {
    try {
        const { r_type, id } = req.params;
        await run("BEGIN TRANSACTION");
        if (r_type === 'transaction') {
            const old = (await all("SELECT * FROM transactions WHERE id = ?", [id]))[0];
            if (old) {
                const diff = old.type === "收入" ? -old.amount : old.amount;
                await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [diff, old.account_id]);
                if (old.stock_ref_id) await run("DELETE FROM stocks WHERE id = ?", [old.stock_ref_id]);
                await run("DELETE FROM transactions WHERE id = ?", [id]);
            }
        } else {
            const old = (await all("SELECT * FROM transfers WHERE id = ?", [id]))[0];
            if (old) {
                await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [old.amount, old.from_account_id]);
                await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [old.amount, old.to_account_id]);
                await run("DELETE FROM transfers WHERE id = ?", [id]);
            }
        }
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/stocks", async (req, res) => {
    try {
        res.json(await all("SELECT s.*, a.name as account_name FROM stocks s JOIN accounts a ON s.account_id = a.id"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(["/webhook/line", "/api/webhook"], (req, res) => {
    res.json({
        ok: true,
        message: "LINE webhook endpoint is ready. Set LINE Developers Webhook URL to this URL and send POST events here.",
        paths: ["/webhook/line", "/api/webhook"]
    });
});
app.post(["/webhook/line", "/api/webhook"], handleLineWebhook);

app.listen(PORT, () => {
    console.log(`🎉 旗艦完全體大腦已在 Port ${PORT} 完美開機！`);
    console.log(`🔗 LINE Webhook ready: /webhook/line 或 /api/webhook`);
});
