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

const firebaseConfig = {
    apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
    databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

let sock;
let contacts = [];

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

    sock.ev.on('messaging-history.set', ({ contacts: newContacts }) => {
        contacts = newContacts.map(c => ({ id: c.id, name: c.name || c.id.split('@')[0] }));
        io.emit('contacts', contacts);
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const cleanId = from.replace(/\D/g, '');

        // Automation Check
        const blockSnap = await get(ref(db, `blocked_users/${cleanId}`));
        if (blockSnap.exists()) return;

        const userRef = ref(db, `sessions/${cleanId}`);
        const snap = await get(userRef);
        let session = snap.val() || { step: 0 };

        // Simple State Machine for Ordering
        if (session.step === 0) {
            let menuTxt = `*Welcome to Royal Kitchen* 🍴\n\n1. Paneer Butter - ₹250\n2. Chicken Biryani - ₹350\n3. Cold Coffee - ₹90\n\nDish No. bhejein:`;
            await sock.sendMessage(from, { text: menuTxt });
            await update(userRef, { step: 1 });
        } else if (session.step === 1) {
            const items = {"1":"Paneer Butter", "2":"Chicken Biryani", "3":"Cold Coffee"};
            const prices = {"1":250, "2":350, "3":90};
            if(items[msgText]) {
                await update(userRef, { step: 2, item: items[msgText], price: prices[msgText] });
                await sock.sendMessage(from, { text: "Kitni quantity?" });
            }
        } else if (session.step === 2) {
            await update(userRef, { step: 3, qty: msgText });
            await sock.sendMessage(from, { text: "Apna Naam aur Address bhejein:" });
        } else if (session.step === 3) {
            const orderId = "ORD" + Math.floor(Math.random()*9000);
            const total = session.price * parseInt(session.qty);
            const orderData = { id: orderId, customer: from, details: session.item, qty: session.qty, total, address: msgText, time: new Date().toLocaleTimeString(), timestamp: Date.now() };
            await set(ref(db, 'orders/active/' + orderId), orderData);
            await sock.sendMessage(from, { text: `✅ Order Placed! ID: ${orderId}\nTotal: ₹${total}` });
            await remove(userRef);
        }
    });
}

// Socket listener for Mark Done
io.on('connection', (socket) => {
    socket.on('mark-done', async (order) => {
        await sock.sendMessage(order.customer, { text: `🎉 Aapka Order (#${order.id}) Deliver ho gaya hai. Thank you!` });
    });
});

// Download Report
app.get('/download-report', async (req, res) => {
    let workbook = new ExcelJS.Workbook();
    let sheet = workbook.addWorksheet('Sales');
    sheet.columns = [{header:'Date', key:'time'}, {header:'Item', key:'details'}, {header:'Total', key:'total'}];
    const snap = await get(ref(db, 'orders/completed'));
    snap.forEach(c => sheet.addRow(c.val()));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Sales.xlsx');
    await workbook.xlsx.write(res); res.end();
});

startBot();
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
http.listen(3000, () => console.log('Server Live on Port 3000'));
