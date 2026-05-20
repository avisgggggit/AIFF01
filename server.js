const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080; 
const db = new sqlite3.Database(path.join(__dirname, "assets.db"));

app.use(express.json());
app.use(express.static(__dirname));

// SQLite 异步包裝
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// 初始化升級版資料表
db.serialize(() => {
    // 1. 帳戶表 (支援三種型態)
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('身上現金', '銀行戶頭', '證券投資')),
            balance REAL NOT NULL DEFAULT 0
        )
    `);

    // 2. 交易表 (加入 category 分類，增強外鍵連動刪除)
    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('收入', '支出')),
            category TEXT NOT NULL,
            amount REAL NOT NULL CHECK(amount > 0),
            date TEXT NOT NULL,
            memo TEXT,
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    // 3. 轉帳紀錄表
    db.run(`
        CREATE TABLE IF NOT EXISTS transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_account_id INTEGER NOT NULL,
            to_account_id INTEGER NOT NULL,
            amount REAL NOT NULL CHECK(amount > 0),
            date TEXT NOT NULL,
            memo TEXT,
            FOREIGN KEY(from_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY(to_account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    // 4. 股票基金庫存表
    db.run(`
        CREATE TABLE IF NOT EXISTS stocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            stock_code TEXT NOT NULL,
            shares REAL NOT NULL CHECK(shares >= 0),
            cost REAL NOT NULL CHECK(cost >= 0),
            UNIQUE(account_id, stock_code),
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);
});

// ==================== API 路由 ====================

// 帳戶：新增
app.post("/api/accounts", async (req, res) => {
    try {
        const { name, type, balance = 0 } = req.body;
        if (!name || !['身上現金', '銀行戶頭', '證券投資'].includes(type)) {
            return res.status(400).json({ error: "參數錯誤" });
        }
        const result = await run("INSERT INTO accounts (name, type, balance) VALUES (?, ?, ?)", [name, type, Number(balance)]);
        res.status(201).json({ id: result.lastID });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 帳戶：列表
app.get("/api/accounts", async (req, res) => {
    try {
        const rows = await all("SELECT * FROM accounts ORDER BY type, id DESC");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 帳戶：修改
app.put("/api/accounts/:id", async (req, res) => {
    try {
        const { name, balance } = req.body;
        await run("UPDATE accounts SET name = ?, balance = ? WHERE id = ?", [name, Number(balance), req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 帳戶：刪除
app.delete("/api/accounts/:id", async (req, res) => {
    try {
        await run("PRAGMA foreign_keys = ON"); // 確保外鍵級聯刪除生效
        await run("DELETE FROM accounts WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 帳戶：單一帳戶的所有明細歷史
app.get("/api/accounts/:id/history", async (req, res) => {
    try {
        const txs = await all("SELECT 'transaction' as record_type, type, category, amount, date, memo FROM transactions WHERE account_id = ? ORDER BY date DESC", [req.params.id]);
        const transfersFrom = await all("SELECT 'transfer_out' as record_type, '轉出' as type, a.name as category, t.amount, t.date, t.memo FROM transfers t JOIN accounts a ON t.to_account_id = a.id WHERE t.from_account_id = ?", [req.params.id]);
        const transfersTo = await all("SELECT 'transfer_in' as record_type, '轉入' as type, a.name as category, t.amount, t.date, t.memo FROM transfers t JOIN accounts a ON t.from_account_id = a.id WHERE t.to_account_id = ?", [req.params.id]);
        
        const history = [...txs, ...transfersFrom, ...transfersTo].sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(history);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 交易：新增記帳 (收/支)
app.post("/api/transactions", async (req, res) => {
    try {
        const { account_id, type, category, amount, date, memo } = req.body;
        const val = Number(amount);
        await run("BEGIN TRANSACTION");
        await run("INSERT INTO transactions (account_id, type, category, amount, date, memo) VALUES (?, ?, ?, ?, ?, ?)", [account_id, type, category, val, date, memo]);
        const delta = type === "收入" ? val : -val;
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [delta, account_id]);
        await run("COMMIT");
        res.status(201).json({ success: true });
    } catch (err) { await run("ROLLBACK").catch(() => {}); res.status(500).json({ error: err.message }); }
});

// 轉帳：新增轉帳
app.post("/api/transfers", async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount, date, memo } = req.body;
        const val = Number(amount);
        if (from_account_id === to_account_id) return res.status(400).json({ error: "不能轉帳給同一個帳戶" });
        
        await run("BEGIN TRANSACTION");
        await run("INSERT INTO transfers (from_account_id, to_account_id, amount, date, memo) VALUES (?, ?, ?, ?, ?)", [from_account_id, to_account_id, val, date, memo]);
        await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [val, from_account_id]);
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [val, to_account_id]);
        await run("COMMIT");
        res.status(201).json({ success: true });
    } catch (err) { await run("ROLLBACK").catch(() => {}); res.status(500).json({ error: err.message }); }
});

// 股票基金：買賣交易
app.post("/api/stocks", async (req, res) => {
    try {
        const { account_id, stock_code, type, shares, price } = req.body;
        const qty = Number(shares);
        const p = Number(price);
        
        const stock = await get("SELECT * FROM stocks WHERE account_id = ? AND stock_code = ?", [account_id, stock_code]);

        if (type === "買進") {
            if (stock) {
                const newShares = stock.shares + qty;
                const newCost = ((stock.shares * stock.cost) + (qty * p)) / newShares;
                await run("UPDATE stocks SET shares = ?, cost = ? WHERE id = ?", [newShares, newCost, stock.id]);
            } else {
                await run("INSERT INTO stocks (account_id, stock_code, shares, cost) VALUES (?, ?, ?, ?)", [account_id, stock_code, qty, p]);
            }
        } else {
            if (!stock || stock.shares < qty) return res.status(400).json({ error: "持股/基金份數不足庫存" });
            const newShares = stock.shares - qty;
            if (newShares === 0) {
                await run("DELETE FROM stocks WHERE id = ?", [stock.id]);
            } else {
                await run("UPDATE stocks SET shares = ? WHERE id = ?", [newShares, stock.id]);
            }
        }
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 股票基金：庫存清單
app.get("/api/stocks", async (req, res) => {
    try {
        const rows = await all(`
            SELECT s.id, s.account_id, a.name AS account_name, s.stock_code, s.shares, s.cost 
            FROM stocks s JOIN accounts a ON a.id = s.account_id 
            ORDER BY s.stock_code
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 用定時器強迫 Event Loop 保持活躍
setInterval(() => {}, 1000 * 60 * 60);

app.listen(PORT, () => {
    console.log(`🎉 耶！升級版伺服器在 Port ${PORT} 完美啟動中！`);
});