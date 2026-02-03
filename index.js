const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const express = require('express');
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set, get, update, remove } = require("firebase/database");
const ExcelJS = require('exceljs');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const firebaseConfig = {
    apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
    databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

let sock;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["Resto-Admin", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) io.emit('qr', qr);
        if (connection === 'open') io.emit('status', 'Connected');
        if (connection === 'close') {
            if ((lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const cleanId = from.replace(/\D/g, ''); // Extracts number

        // Automation Check - Agar number blocked list mein hai toh bot reply nahi karega
        const blockSnap = await get(ref(db, `blocked_users/${cleanId}`));
        if (blockSnap.exists()) return;

        const userRef = ref(db, `sessions/${cleanId}`);
        const snap = await get(userRef);
        let session = snap.val() || { step: 0 };

        // Ordering Logic (Same stable flow)
        if (session.step === 0) {
            await sock.sendMessage(from, { text: `*Welcome!* 🍴\n1. Pizza - ₹299\n2. Burger - ₹99\n\nNumber bhejein:` });
            await update(userRef, { step: 1 });
        } else if (session.step === 1) {
            const items = {"1": "Pizza", "2": "Burger"};
            if(items[m.message.conversation]) {
                await update(userRef, { step: 2, item: items[m.message.conversation] });
                await sock.sendMessage(from, { text: "Kitni quantity?" });
            }
        } else if (session.step === 2) {
            await update(userRef, { step: 3, qty: m.message.conversation });
            await sock.sendMessage(from, { text: "Apna Naam aur Address bhejein:" });
        } else if (session.step === 3) {
            const orderId = "ORD" + Date.now().toString().slice(-4);
            await set(ref(db, 'orders/active/' + orderId), {
                id: orderId, customer: from, details: session.item, qty: m.message.conversation,
                address: m.message.conversation, time: new Date().toLocaleTimeString(), timestamp: Date.now()
            });
            await sock.sendMessage(from, { text: `✅ Order Received! ID: ${orderId}` });
            await remove(userRef);
        }
    });
}

// Download Report API
app.get('/download-report', async (req, res) => {
    let workbook = new ExcelJS.Workbook();
    let sheet = workbook.addWorksheet('Sales');
    sheet.columns = [{header:'Order ID', key:'id'}, {header:'Item', key:'details'}, {header:'Time', key:'time'}];
    const snap = await get(ref(db, 'orders/completed'));
    snap.forEach(c => sheet.addRow(c.val()));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Report.xlsx');
    await workbook.xlsx.write(res); res.end();
});

startBot();
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
http.listen(3000, () => console.log('Server Live at Port 3000'));
