const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const express = require('express');
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set, get, update, remove, query, orderByChild, endAt } = require("firebase/database");
const ExcelJS = require('exceljs');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- FIREBASE CONFIG (Wahi jo aapne di thi) ---
const firebaseConfig = {
    apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
    databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const menu = {
    "1": { item: "Paneer Butter Masala", price: 220 },
    "2": { item: "Veg Biryani Full", price: 180 },
    "3": { item: "Butter Naan", price: 40 },
    "4": { item: "Cold Drink", price: 60 }
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["Restaurant Manager", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) io.emit('qr', qr);
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            io.emit('status', 'Connected');
            console.log("✅ WhatsApp Connected!");
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const cleanId = from.replace(/\D/g, '');

        // Check if automation is OFF for this user
        const blockSnap = await get(ref(db, `settings/blocked/${cleanId}`));
        if (blockSnap.exists() && blockSnap.val() === true) return;

        const userRef = ref(db, `sessions/${cleanId}`);
        const snap = await get(userRef);
        let session = snap.val() || { step: 0 };

        if (session.step === 0) {
            let welcome = `*Aapka Swagat Hai!* 🍴\n`;
            for (let id in menu) welcome += `\n*${id}.* ${menu[id].item} - ₹${menu[id].price}`;
            welcome += `\n\nOrder ke liye *Number* likhen:`;
            await sock.sendMessage(from, { text: welcome });
            await update(userRef, { step: 1 });
        } 
        else if (session.step === 1) {
            if (menu[msgText]) {
                await update(userRef, { step: 2, item: menu[msgText].item, price: menu[msgText].price });
                await sock.sendMessage(from, { text: `Aapne ${menu[msgText].item} chuna. Quantity likhen:` });
            }
        }
        else if (session.step === 2) {
            await update(userRef, { step: 3, qty: msgText });
            await sock.sendMessage(from, { text: `Payment Method:\n1. Cash (COD)\n2. Online` });
        }
        else if (session.step === 3) {
            await update(userRef, { step: 4, pay: msgText == '1' ? 'COD' : 'Online' });
            await sock.sendMessage(from, { text: `Order ke liye *Naam aur Pura Address* bhejein:` });
        }
        else if (session.step === 4) {
            const orderId = "ORD" + Math.floor(Math.random() * 9000);
            const finalOrder = {
                id: orderId,
                customer: from,
                details: `${session.item} (Qty: ${session.qty})`,
                total: session.price * (parseInt(session.qty) || 1),
                address: msgText,
                pay: session.pay,
                time: new Date().toLocaleString(),
                timestamp: Date.now()
            };
            await set(ref(db, 'orders/active/' + orderId), finalOrder);
            await sock.sendMessage(from, { text: `✅ Order Placed! ID: ${orderId}\nTotal: ₹${finalOrder.total}` });
            await remove(userRef);
        }
    });
}

// Excel Report & 7-Day Auto Delete
app.get('/download-report', async (req, res) => {
    let workbook = new ExcelJS.Workbook();
    let sheet = workbook.addWorksheet('Orders');
    sheet.columns = [{header:'ID', key:'id'}, {header:'Item', key:'details'}, {header:'Total', key:'total'}, {header:'Address', key:'address'}];
    const snap = await get(ref(db, 'orders/completed'));
    snap.forEach(c => { sheet.addRow(c.val()); });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Report.xlsx');
    await workbook.xlsx.write(res); res.end();
});

// Purge old orders
setInterval(async () => {
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const completedRef = ref(db, 'orders/completed');
    const oldQuery = query(completedRef, orderByChild('timestamp'), endAt(weekAgo));
    const snap = await get(oldQuery);
    snap.forEach(c => remove(c.ref));
}, 86400000);

startBot();
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
http.listen(3000, () => console.log('Server Live: http://localhost:3000'));
