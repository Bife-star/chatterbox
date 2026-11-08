import { auth, db, A, F } from "./firebase.js";
import { startCall, onChats } from "./calls.js";
import { initLive, stopLive } from "./live.js";

const $ = id => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { alert("Browser storage is full."); } };
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const initial = n => (n || "?")[0].toUpperCase();
const COLORS = ["#2f5bea", "#e0603a", "#7a4fd6", "#1b8a7a", "#c2447a"];
const colorOf = s => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 5];

// Settings, ads and diary are still saved in the browser (backend for these comes later)
let cfg = load("cb-cfg", { name: "Me", theme: "light", accent: "#2f5bea", size: 16, pic: "", privacy: "anyone" });
cfg.privacy = cfg.privacy || "anyone";
let ads = [], diary = [];   // shared marketplace and your diary now live in the database

let me = null, chats = [], msgs = [], active = null, want = null, blocked = new Set();
let unsubs = [], unsubMsgs = null, signup = false, pending = false;

const chat = () => chats.find(c => c.id === active);
const chatById = id => chats.find(c => c.id === id);
const other = c => c.members.find(x => x !== me.uid);
const title = c => c.group ? c.name : (c.names || {})[other(c)] || "Chat";
let contacts = [];   // people you added
const photos = {};   // profile pictures of other users, loaded once
function setAvatar(el, name, uid) {
  if (uid && photos[uid]) { el.style.backgroundImage = `url(${photos[uid]})`; el.textContent = ""; }
  else { el.style.backgroundImage = ""; el.style.backgroundColor = colorOf(name); el.textContent = initial(name); }
}
async function loadPhotos() {
  const need = chats.filter(c => !c.group).map(other).filter(u => !(u in photos));
  need.forEach(u => photos[u] = "");
  await Promise.all(need.map(async u => { try { photos[u] = (await F.getDoc(F.doc(db, "users", u))).data().photo || ""; } catch (e) {} }));
  if (need.length) { renderList(); const c = chat(); c && setAvatar($("cAvatar"), title(c), c.group ? null : other(c)); }
}
const isBlocked = c => !!c && !c.group && blocked.has(other(c));

// ================= Accounts =================
$("authSwitch").onclick = () => {
  signup = !signup;
  $("authUser").hidden = !signup;
  $("authGo").textContent = signup ? "Create account" : "Log in";
  $("authSwitch").textContent = signup ? "I already have an account" : "Create an account";
  $("authErr").textContent = "";
};

$("authForm").onsubmit = async e => {
  e.preventDefault(); $("authErr").textContent = "";
  const email = $("authEmail").value.trim(), pass = $("authPass").value, user = $("authUser").value.trim().toLowerCase();
  try {
    if (!signup) { await A.signInWithEmailAndPassword(auth, email, pass); return; }
    if (!/^[a-z0-9_]{3,20}$/.test(user)) throw new Error("Username: 3 to 20 letters, numbers or _");
    pending = true;
    const cred = await A.createUserWithEmailAndPassword(auth, email, pass);
    try {
      // Claim the username and create the profile together, so two people can't take the same name
      await F.runTransaction(db, async t => {
        const ref = F.doc(db, "usernames", user);
        if ((await t.get(ref)).exists()) throw new Error("That username is taken");
        t.set(ref, { uid: cred.user.uid });
        t.set(F.doc(db, "users", cred.user.uid), { username: user, name: user });
      });
    } catch (err) { await cred.user.delete(); throw err; }
    pending = false; await start(cred.user);
  } catch (err) {
    pending = false;
    $("authErr").textContent = err.message.replace("Firebase: ", "");
  }
};

A.onAuthStateChanged(auth, u => { if (pending) return; u ? start(u) : stop(); });

async function start(u) {
  const snap = await F.getDoc(F.doc(db, "users", u.uid));
  me = { uid: u.uid, ...snap.data() };
  if (me.photo) { cfg.pic = me.photo; photos[me.uid] = me.photo; }
  cfg.privacy = me.privacy || "anyone";
  cfg.name = me.username; save("cb-cfg", cfg); applyCfg();
  initLive(me);
  $("auth").hidden = true;
  unsubs = [
    F.onSnapshot(F.query(F.collection(db, "chats"), F.where("members", "array-contains", me.uid)), s => {
      chats = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      if (want && chatById(want)) { const w = want; want = null; openChat(w); }
      renderList(); renderBlocked();
      onChats(chats, me, c => isBlocked(c) || (cfg.privacy === "added" && !(c.call && contacts.some(x => x.id === c.call.from))));
      loadPhotos();
      if (active && !chat()) { active = null; $("shell").classList.remove("open"); }
    }),
    F.onSnapshot(F.collection(db, "users", me.uid, "blocked"), s => {
      blocked = new Set(s.docs.map(d => d.id)); renderList(); updateBlockUI(); renderBlocked();
    })
  ];
  unsubs.push(...watchShared());
}

function stop() {
  stopLive();
  unsubs.forEach(f => f()); unsubMsgs && unsubMsgs();
  unsubs = []; unsubMsgs = null; me = null; chats = []; msgs = []; active = null;
  $("chatList").innerHTML = ""; $("msgs").innerHTML = ""; $("shell").classList.remove("open");
  ads = []; diary = []; renderAds(); renderDiary();
  $("auth").hidden = false;
}
$("logout").onclick = () => A.signOut(auth);

// ================= Navigation =================
document.querySelectorAll(".rail button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".rail button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "v-" + b.dataset.view));
});

// ================= Settings =================
function applyCfg() {
  document.documentElement.dataset.theme = cfg.theme;
  document.documentElement.style.setProperty("--accent", cfg.accent);
  document.documentElement.style.fontSize = cfg.size + "px";
  $("setName").value = cfg.name; $("setTheme").value = cfg.theme;
  $("setAccent").value = cfg.accent; $("setSize").value = cfg.size; $("setPrivacy").value = cfg.privacy;
  $("myPic").style.backgroundImage = cfg.pic ? `url(${cfg.pic})` : "";
  $("myPic").textContent = cfg.pic ? "" : initial(cfg.name);
}
[["setName", "name"], ["setTheme", "theme"], ["setAccent", "accent"], ["setSize", "size"], ["setPrivacy", "privacy"]].forEach(([id, key]) =>
  $(id).oninput = e => { cfg[key] = e.target.value; save("cb-cfg", cfg); applyCfg(); });
$("picBtn").onclick = () => $("picFile").click();
$("picFile").onchange = async e => {
  if (!e.target.files[0]) return;
  cfg.pic = await resize(e.target.files[0], 160); save("cb-cfg", cfg); applyCfg();
  if (me) F.setDoc(F.doc(db, "users", me.uid), { photo: cfg.pic }, { merge: true });
};
$("wipe").onclick = () => { if (confirm("Delete the data saved in this browser?")) { localStorage.clear(); location.reload(); } };

// ================= Pictures =================
function resize(file, h, top, bottom) {
  return new Promise(done => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, h / img.height), c = document.createElement("canvas");
      c.width = img.width * s; c.height = img.height * s;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0, c.width, c.height);
      x.font = `bold ${c.height / 9}px sans-serif`; x.textAlign = "center";
      x.fillStyle = "#fff"; x.strokeStyle = "#000"; x.lineWidth = c.height / 60;
      [[top, c.height / 8], [bottom, c.height * 0.96]].forEach(([t, y]) => {
        if (t) { x.strokeText(t.toUpperCase(), c.width / 2, y); x.fillText(t.toUpperCase(), c.width / 2, y); }
      });
      done(c.toDataURL("image/jpeg", 0.8));
    };
    img.src = URL.createObjectURL(file);
  });
}

// ================= Chat list and messages =================
function renderList() {
  $("chatList").innerHTML = "";
  chats.forEach(c => {
    const li = document.createElement("li");
    li.className = "item" + (c.id === active ? " on" : "");
    li.innerHTML = '<div class="avatar"></div><div class="info"><strong></strong><div class="pre"></div></div>';
    const t = title(c);
    setAvatar(li.querySelector(".avatar"), t, c.group ? null : other(c));
    li.querySelector("strong").textContent = t + (c.group ? " (group)" : "") + (isBlocked(c) ? " (blocked)" : "");
    li.querySelector(".pre").textContent = c.last || "No messages yet";
    li.onclick = () => openChat(c.id);
    $("chatList").appendChild(li);
  });
}

function renderMsgs() {
  const box = $("msgs"); box.innerHTML = "";
  if (!chat()) return;
  if (!msgs.length) { box.innerHTML = '<p class="empty">No messages yet. Say hello.</p>'; return; }
  msgs.forEach(m => {
    const mine = m.from === me.uid, d = document.createElement("div");
    d.className = "bubble " + (mine ? "sent" : "recv") + (m.type === "sticker" ? " sticker" : "") + (m.type === "text" && mine ? " text" : "");
    if (m.type === "text") {
      const t = document.createElement("span"); t.textContent = m.text; d.append(t);
      if (mine) { d.title = "Tap to edit"; d.onclick = () => editMsg(m); }
    } else if (m.type === "image") { const im = new Image(); im.src = m.src; d.append(im); }
    else if (m.type === "voice") d.append(voicePlayer(m));
    else d.textContent = m.text;
    if (m.type !== "sticker") {
      const t = document.createElement("time"); t.textContent = clock(m.time) + (m.edited ? " · edited" : ""); d.append(t);
    }
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
}

function openChat(id) {
  active = id; const c = chat(), t = title(c);
  $("cName").textContent = t; $("cStatus").textContent = c.group ? c.members.length + " members" : "";
  setAvatar($("cAvatar"), t, c.group ? null : other(c));
  $("shell").classList.add("open"); $("moreMenu").hidden = true;
  unsubMsgs && unsubMsgs(); msgs = [];
  unsubMsgs = F.onSnapshot(F.query(F.collection(db, "chats", id, "messages"), F.orderBy("time")), s => {
    msgs = s.docs.map(d => ({ id: d.id, ...d.data() })); renderMsgs();
  });
  updateBlockUI(); renderList(); renderMsgs();
}
$("back").onclick = () => $("shell").classList.remove("open");

async function findUser(name) {
  const n = name.trim().toLowerCase().replace(/^@/, "");
  const s = await F.getDoc(F.doc(db, "usernames", n));
  if (!s.exists()) throw new Error("No user named " + n);
  const u = await F.getDoc(F.doc(db, "users", s.data().uid));
  return { uid: s.data().uid, ...u.data() };
}

$("newChat").onclick = async () => {
  if (!me) return;
  const group = confirm("Group chat? OK = group, Cancel = one-to-one");
  try {
    if (!group) {
      const n = prompt("Username to message:"); if (!n) return;
      const u = await findUser(n);
      if (u.uid === me.uid) throw new Error("That's you");
      await addContact(u.uid, u.username);   // starting a chat adds them to your contacts
      const id = [me.uid, u.uid].sort().join("_");   // same two people always get the same chat
      want = id;
      await F.setDoc(F.doc(db, "chats", id), { members: [me.uid, u.uid], group: false, names: { [me.uid]: me.username, [u.uid]: u.username } }, { merge: true });
    } else {
      const g = prompt("Group name:"); if (!g) return;
      const list = (prompt("Usernames to add, separated by commas:") || "").split(",").filter(x => x.trim());
      const us = await Promise.all(list.map(findUser));
      const ref = await F.addDoc(F.collection(db, "chats"), { members: [...new Set([me.uid, ...us.map(u => u.uid)])], group: true, name: g.trim(), updated: Date.now() });
      want = ref.id;
    }
  } catch (err) { want = null; alert(err.message); }
};

// ================= Sending =================
async function push(msg) {
  const c = chat(); if (!c || isBlocked(c)) return;
  try {
    await F.addDoc(F.collection(db, "chats", c.id, "messages"), { from: me.uid, time: Date.now(), ...msg });
    await F.updateDoc(F.doc(db, "chats", c.id), { updated: Date.now(), last: msg.type === "text" ? msg.text : "[" + msg.type + "]" });
  } catch (err) {
    alert("Message not delivered. " + (err.code === "permission-denied" ? "This person may have blocked you, or only accepts messages from people they have added." : err.message));
  }
}
async function editMsg(m) {
  const t = prompt("Edit message (empty = delete):", m.text);
  if (t === null) return;
  const ref = F.doc(db, "chats", active, "messages", m.id);
  try { t.trim() ? await F.updateDoc(ref, { text: t.trim(), edited: true }) : await F.deleteDoc(ref); }
  catch (err) { alert(err.message); }
}
$("form").onsubmit = e => {
  e.preventDefault();
  const t = $("text").value.trim(); if (!t || !active) return;
  push({ type: "text", text: t }); $("text").value = ""; syncSend();
};

let fileMode = "image";
$("imgBtn").onclick = () => { fileMode = "image"; $("file").click(); };
$("memeBtn").onclick = () => { fileMode = "meme"; $("file").click(); };
$("file").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !active) return;
  let top = "", bottom = "";
  if (fileMode === "meme") { top = prompt("Top text:") || ""; bottom = prompt("Bottom text:") || ""; }
  const src = await resize(f, +$("quality").value, top, bottom);
  if (src.length > 900000) return alert("Picture is too big. Pick a lower quality.");
  push({ type: "image", src });
};

const EMOJI = "😀😂🤣😊😍😘😎🤔😢😭😡👍👎👏🙏💪🔥🎉❤️💔✨🌍😴🤝👀💯".match(/\p{Extended_Pictographic}\uFE0F?/gu);
const STICKERS = ["🐶", "🐱", "🦄", "🐼", "🦊", "🐸", "🍕", "🍔", "⚽", "🚀", "🎂", "🌈", "👑", "💃", "🕺", "🤖"];
function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const g = $("pickerGrid"); g.innerHTML = ""; g.classList.toggle("big", tab === "sticker");
  (tab === "emoji" ? EMOJI : STICKERS).forEach(s => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = s;
    b.onclick = () => tab === "emoji" ? ($("text").value += s, syncSend(), $("text").focus()) : active && push({ type: "sticker", text: s });
    g.appendChild(b);
  });
}
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
$("pickBtn").onclick = () => { $("picker").hidden = !$("picker").hidden; showTab("emoji"); };
$("plusBtn").onclick = () => $("tray").hidden = !$("tray").hidden;
$("stickBtn").onclick = () => { $("picker").hidden = false; showTab("sticker"); $("tray").hidden = true; };
// Show the mic when the box is empty and the send arrow when there is text (like WhatsApp)
function syncSend() { const has = $("text").value.trim().length > 0; $("send").hidden = !has; $("micBtn").hidden = has; }
$("text").addEventListener("input", syncSend);

// ================= Voice notes (tap the mic, speak, tap the arrow to send) =================
let rec = null, chunks = [], recStart = 0, recTick = null, recSend = true;
async function startRec() {
  if (!active) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });   // small files, still clear for speech
    chunks = []; recSend = true;
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop()); clearInterval(recTick);
      $("recBar").hidden = true; $("text").hidden = false; syncSend();
      const dur = Math.round((Date.now() - recStart) / 1000);
      if (!recSend || dur < 1) return;
      const r = new FileReader();
      r.onload = () => r.result.length > 900000 ? alert("Voice note too long.") : push({ type: "voice", src: r.result, dur });
      r.readAsDataURL(new Blob(chunks, { type: rec.mimeType }));
    };
    rec.start(); recStart = Date.now();
    $("text").hidden = true; $("micBtn").hidden = true; $("send").hidden = true; $("recBar").hidden = false; $("recTime").textContent = "0:00";
    recTick = setInterval(() => {
      const t = Math.round((Date.now() - recStart) / 1000);
      $("recTime").textContent = Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
      if (t >= 120) rec.stop();   // 2 minute limit
    }, 500);
  } catch (err) { alert("Allow microphone access to record."); }
}
$("micBtn").onclick = startRec;
$("recSend").onclick = () => rec && rec.state === "recording" && rec.stop();
$("recCancel").onclick = () => { recSend = false; rec && rec.state === "recording" && rec.stop(); };

function voicePlayer(m) {
  const w = document.createElement("div"); w.className = "vn";
  const a = new Audio(m.src), b = document.createElement("button"), bar = document.createElement("div");
  const fill = document.createElement("i"), t = document.createElement("span");
  const fmt = x => Math.floor(x / 60) + ":" + String(Math.floor(x % 60)).padStart(2, "0");
  b.type = "button"; b.textContent = "▶"; bar.className = "bar"; bar.appendChild(fill); t.textContent = fmt(m.dur || 0);
  b.onclick = e => { e.stopPropagation(); a.paused ? a.play() : a.pause(); };
  a.onplay = () => b.textContent = "⏸"; a.onpause = () => b.textContent = "▶";
  a.ontimeupdate = () => { fill.style.width = (a.currentTime / (m.dur || a.duration || 1) * 100) + "%"; t.textContent = fmt(a.currentTime); };
  a.onended = () => { fill.style.width = "0"; t.textContent = fmt(m.dur || 0); b.textContent = "▶"; };
  bar.onclick = e => { const r = bar.getBoundingClientRect(); a.currentTime = (e.clientX - r.left) / r.width * (m.dur || a.duration || 0); };
  w.append(b, bar, t); return w;
}

// ================= Calls (the call screens live in calls.js) =================
$("voiceCall").onclick = () => startCall({ chat: chat(), me, video: false, name: title(chat()) });
$("videoCall").onclick = () => startCall({ chat: chat(), me, video: true, name: title(chat()) });

// ================= Block and report (saved on the server) =================
function updateBlockUI() {
  const c = chat(), off = !c || isBlocked(c);
  ["text", "send", "imgBtn", "memeBtn", "micBtn", "pickBtn", "plusBtn", "stickBtn", "voiceCall", "videoCall"].forEach(x => $(x).disabled = off);
  $("moreBtn").disabled = !c;
  $("text").placeholder = c && off ? "You blocked this person" : "Chat here";
  $("blockBtn").textContent = isBlocked(c) ? "Unblock" : "Block";
}
async function toggleBlock(ask = true) {
  const c = chat(); if (!c) return;
  if (c.group) return alert("You can leave groups later; blocking works on one-to-one chats.");
  const ref = F.doc(db, "users", me.uid, "blocked", other(c));
  if (isBlocked(c)) return F.deleteDoc(ref);
  if (ask && !confirm("Block " + title(c) + "? They won't be able to message you.")) return;
  await F.setDoc(ref, { time: Date.now() });
}
function renderBlocked() {
  const ul = $("blockedList"); ul.innerHTML = "";
  const list = chats.filter(isBlocked);
  if (!list.length) { ul.innerHTML = '<li class="muted">No one blocked.</li>'; return; }
  list.forEach(c => {
    const li = document.createElement("li"); li.className = "row";
    const n = document.createElement("span"); n.className = "grow"; n.textContent = title(c);
    const b = document.createElement("button"); b.textContent = "Unblock";
    b.onclick = () => F.deleteDoc(F.doc(db, "users", me.uid, "blocked", other(c)));
    li.append(n, b); ul.appendChild(li);
  });
}
async function reportChat() {
  const c = chat(); if (!c) return;
  const reason = prompt("Why are you reporting " + title(c) + "? (spam, harassment, scam, other)");
  if (!reason) return;
  try {
    await F.addDoc(F.collection(db, "reports"), {
      by: me.uid, chat: c.id, about: c.group ? null : other(c), reason, time: Date.now(),
      last: msgs.slice(-5).map(m => ({ from: m.from, type: m.type, text: m.type === "text" ? m.text : "" }))
    });
    alert("Report sent. Thank you.");
    if (!c.group && !isBlocked(c) && confirm("Also block " + title(c) + "?")) toggleBlock(false);
  } catch (err) { alert(err.message); }
}
$("moreBtn").onclick = e => { e.stopPropagation(); $("moreMenu").hidden= !$("moreMenu").hidden; };
document.addEventListener("click", () => $("moreMenu").hidden = true);
$("blockBtn").onclick = () => toggleBlock();
$("reportBtn").onclick = reportChat;

// ================= Live: handled in live.js =================

// ================= Marketplace (shared with everyone) and Room (your diary, on your account) =================
function watchShared() {
  return [
    F.onSnapshot(F.query(F.collection(db, "ads"), F.orderBy("time", "desc"), F.limit(100)), snap => {
      ads = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderAds();
    }),
    F.onSnapshot(F.query(F.collection(db, "users", me.uid, "diary"), F.orderBy("time", "desc")), snap => {
      diary = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderDiary();
    }),
    F.onSnapshot(F.collection(db, "users", me.uid, "contacts"), snap => {
      contacts = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderContacts();
    })
  ];
}

function renderAds() {
  $("ads").innerHTML = "";
  if (!me) return;
  if (!ads.length) { $("ads").innerHTML = '<p class="muted">No ads yet. Be the first to post.</p>'; return; }
  ads.forEach(a => {
    const d = document.createElement("div"); d.className = "card";
    d.innerHTML = '<img alt=""><div><strong></strong><p class="price"></p><p class="muted"></p><p class="muted"></p><div class="row"></div></div>';
    if (a.img) d.querySelector("img").src = a.img;
    const [t, p, desc, by] = d.querySelectorAll("strong,.price,.muted");
    t.textContent = a.title; p.textContent = a.price; desc.textContent = a.desc; by.textContent = "Sold by " + a.by;
    const b = document.createElement("button");
    if (a.uid === me.uid) { b.className = "danger"; b.textContent = "Remove"; b.onclick = () => F.deleteDoc(F.doc(db, "ads", a.id)); }
    else { b.className = "primary"; b.textContent = "Message seller"; b.onclick = () => messageUser(a.uid); }
    d.querySelector(".row").appendChild(b); $("ads").appendChild(d);
  });
}

$("adForm").onsubmit = async e => {
  e.preventDefault(); if (!me) return;
  const f = $("adImg").files[0];
  try {
    await F.addDoc(F.collection(db, "ads"), {
      uid: me.uid, by: me.username, time: Date.now(),
      title: $("adTitle").value.trim().slice(0, 80), price: $("adPrice").value.trim().slice(0, 30),
      desc: $("adDesc").value.trim().slice(0, 500), img: f ? await resize(f, 360) : ""
    });
    e.target.reset();
  } catch (err) { alert(err.message); }
};

async function messageUser(uid) {   // opens (or starts) a chat with a seller
  if (uid === me.uid) return;
  try {
    const u = (await F.getDoc(F.doc(db, "users", uid))).data();
    await addContact(uid, u.username);
    const id = [me.uid, uid].sort().join("_"); want = id;
    await F.setDoc(F.doc(db, "chats", id), { members: [me.uid, uid], group: false, names: { [me.uid]: me.username, [uid]: u.username } }, { merge: true });
    document.querySelector('.rail button[data-view="chats"]').click();
  } catch (err) { want = null; alert(err.message); }
}

function renderDiary() {
  $("entries").innerHTML = "";
  if (!me) return;
  diary.forEach(en => {
    const d = document.createElement("div"); d.className = "entry";
    d.textContent = new Date(en.time).toLocaleString() + "\n" + en.text;
    d.title = "Tap to delete";
    d.onclick = () => confirm("Delete this entry?") && F.deleteDoc(F.doc(db, "users", me.uid, "diary", en.id));
    $("entries").appendChild(d);
  });
}
$("diaryForm").onsubmit = async e => {
  e.preventDefault(); const t = $("diaryText").value.trim(); if (!t || !me) return;
  try { await F.addDoc(F.collection(db, "users", me.uid, "diary"), { text: t, time: Date.now() }); $("diaryText").value = ""; }
  catch (err) { alert(err.message); }
};

// ================= Contacts (used by "Only people I've added") =================
function renderContacts() {
  const ul = $("contactList"); ul.innerHTML = "";
  if (!contacts.length) { ul.innerHTML = '<li class="muted">No contacts yet.</li>'; return; }
  contacts.forEach(c => {
    const li = document.createElement("li"); li.className = "row";
    const n = document.createElement("span"); n.className = "grow"; n.textContent = c.username;
    const b = document.createElement("button"); b.textContent = "Remove";
    b.onclick = () => F.deleteDoc(F.doc(db, "users", me.uid, "contacts", c.id));
    li.append(n, b); ul.appendChild(li);
  });
}
const addContact = (uid, username) => F.setDoc(F.doc(db, "users", me.uid, "contacts", uid), { username, time: Date.now() });
$("addContact").onclick = async () => {
  const n = prompt("Username to add:"); if (!n || !me) return;
  try {
    const u = await findUser(n);
    if (u.uid === me.uid) throw new Error("That's you");
    await addContact(u.uid, u.username);
  } catch (err) { alert(err.message); }
};
// Save the "Who can message me" choice on your account so the server can enforce it
$("setPrivacy").addEventListener("change", () => me && F.setDoc(F.doc(db, "users", me.uid), { privacy: cfg.privacy }, { merge: true }));

applyCfg();
