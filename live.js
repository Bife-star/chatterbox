// Live section: go live, see who is live, watch, and comment.
// The host's phone sends video straight to each viewer (WebRTC).
// Firebase only passes the connection details and the comments.
import { db, F } from "./firebase.js";

const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };
const $ = id => document.getElementById(id);

let me = null, mode = "idle";            // idle | host | view
let cur = null, curName = "", title = "", count = 0;
let local = null, pc = null, subs = [], peers = new Map();
let beat = null, listTimer = null, unsubList = null, lives = [];

// A box for the "Live now" list, placed under the Live heading
const list = document.createElement("div");
list.className = "stack";
$("v-live").querySelector("h2").after(list);

const fresh = l => Date.now() - (l.beat || 0) < 60000;   // a live that stopped sending signals disappears

function renderList() {
  list.innerHTML = "<strong>Live now</strong>";
  const now = lives.filter(l => fresh(l) && me && l.id !== me.uid);
  if (!now.length) { list.innerHTML += '<p class="muted">No one is live right now.</p>'; return; }
  now.forEach(l => {
    const row = document.createElement("div"); row.className = "box row";
    const t = document.createElement("span"); t.className = "grow";
    t.textContent = l.hostName + ": " + l.title + " (" + (l.viewers || 0) + " watching)";
    const b = document.createElement("button"); b.className = "primary"; b.textContent = "Watch";
    b.onclick = () => watch(l.id, l.hostName);
    row.append(t, b); list.appendChild(row);
  });
}

function ui() {
  $("liveBtn").textContent = mode === "host" ? "End live" : mode === "view" ? "Leave" : "Start live";
  $("liveTitle").hidden = mode !== "idle";
  list.hidden = mode !== "idle";
  $("liveState").textContent = mode === "host" ? "LIVE: " + title + " (" + count + " watching)"
    : mode === "view" ? "Watching " + curName : "Offline";
}

// ---------- Comments (everyone in the live sees them) ----------
function watchComments(hostId) {
  $("liveChat").innerHTML = "";
  subs.push(F.onSnapshot(F.query(F.collection(db, "lives", hostId, "comments"), F.orderBy("time", "desc"), F.limit(100)), s => {
    const box = $("liveChat"); box.innerHTML = "";
    s.docs.reverse().forEach(d => {
      const c = d.data(), p = document.createElement("p");
      p.textContent = c.name + ": " + c.text; box.appendChild(p);
    });
    box.scrollTop = box.scrollHeight;
  }));
}

$("liveForm").onsubmit = async e => {
  e.preventDefault();
  const text = $("liveText").value.trim().slice(0, 300);
  if (!text) return;
  if (!cur) return alert("Join a live first, or start your own.");
  $("liveText").value = "";
  try { await F.addDoc(F.collection(db, "lives", cur, "comments"), { uid: me.uid, name: me.username, text, time: Date.now() }); }
  catch (err) { alert(err.message); }
};

// ---------- Hosting ----------
async function startLive() {
  try { local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
  catch (e) { return alert("Allow camera and microphone access to go live."); }
  title = $("liveTitle").value.trim() || "Untitled"; count = 0;
  mode = "host"; cur = me.uid;
  $("liveVideo").srcObject = local; $("liveVideo").muted = true;
  try {
    const ref = F.doc(db, "lives", me.uid);
    await F.setDoc(ref, { hostName: me.username, title, beat: Date.now(), viewers: 0 });
    // The heartbeat tells everyone we are still live
    beat = setInterval(() => F.updateDoc(ref, { beat: Date.now() }).catch(() => {}), 20000);
    subs.push(F.onSnapshot(F.collection(db, "lives", me.uid, "viewers"), s => {
      count = s.size; F.updateDoc(ref, { viewers: count }).catch(() => {}); ui();
      s.docChanges().forEach(ch => {
        if (ch.type === "added") hostAnswer(ch.doc);
        if (ch.type === "removed") { const p = peers.get(ch.doc.id); p && p.close(); peers.delete(ch.doc.id); }
      });
    }));
    watchComments(me.uid);
  } catch (e) { alert("Could not go live: " + e.message); cleanup(); }
  ui();
}

// A viewer joined: answer their request and send them our video
async function hostAnswer(docSnap) {
  const d = docSnap.data(), vid = docSnap.id;
  if (!d.offer || d.answer || peers.has(vid) || !local) return;
  try {
    const p = new RTCPeerConnection(ICE); peers.set(vid, p);
    local.getTracks().forEach(t => p.addTrack(t, local));
    p.onicecandidate = e => e.candidate && F.addDoc(F.collection(docSnap.ref, "hostCandidates"), e.candidate.toJSON());
    await p.setRemoteDescription(d.offer);
    const a = await p.createAnswer(); await p.setLocalDescription(a);
    await F.updateDoc(docSnap.ref, { answer: { type: a.type, sdp: a.sdp } });
    subs.push(F.onSnapshot(F.collection(docSnap.ref, "viewerCandidates"), s =>
      s.docChanges().forEach(ch => ch.type === "added" && p.addIceCandidate(ch.doc.data()))));
  } catch (e) { console.error(e); }
}

// ---------- Watching ----------
async function watch(hostId, hostName) {
  if (mode !== "idle") return alert("Leave your current live first.");
  mode = "view"; cur = hostId; curName = hostName;
  const vref = F.doc(db, "lives", hostId, "viewers", me.uid);
  pc = new RTCPeerConnection(ICE);
  const remote = new MediaStream();
  pc.ontrack = e => e.streams[0].getTracks().forEach(t => remote.addTrack(t));
  $("liveVideo").srcObject = remote; $("liveVideo").muted = false;
  $("liveVideo").play().catch(() => {});
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.onicecandidate = e => e.candidate && F.addDoc(F.collection(vref, "viewerCandidates"), e.candidate.toJSON());
  try {
    const o = await pc.createOffer(); await pc.setLocalDescription(o);
    await F.setDoc(vref, { name: me.username, offer: { type: o.type, sdp: o.sdp }, time: Date.now() });
    subs.push(F.onSnapshot(vref, async s => {
      const d = s.data();
      if (d && d.answer && pc && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(d.answer);
        subs.push(F.onSnapshot(F.collection(vref, "hostCandidates"), sn =>
          sn.docChanges().forEach(ch => ch.type === "added" && pc && pc.addIceCandidate(ch.doc.data()))));
      }
    }));
    subs.push(F.onSnapshot(F.doc(db, "lives", hostId), s => { if (!s.exists()) { alert("The live has ended."); leave(); } }));
    watchComments(hostId);
  } catch (e) { alert("Could not join: " + e.message); leave(); }
  ui();
}

// ---------- Ending ----------
function cleanup() {
  clearInterval(beat);
  subs.forEach(f => f()); subs = [];
  peers.forEach(p => p.close()); peers.clear();
  pc && pc.close(); pc = null;
  local && local.getTracks().forEach(t => t.stop()); local = null;
  $("liveVideo").srcObject = null; $("liveChat").innerHTML = "";
  mode = "idle"; cur = null; ui();
}
async function endLive() {
  const id = me.uid;
  const viewers = await F.getDocs(F.collection(db, "lives", id, "viewers")).catch(() => null);
  cleanup();
  try { viewers && viewers.forEach(d => F.deleteDoc(d.ref)); await F.deleteDoc(F.doc(db, "lives", id)); } catch (e) {}
}
async function leave() {
  const host = cur; cleanup();
  try { host && await F.deleteDoc(F.doc(db, "lives", host, "viewers", me.uid)); } catch (e) {}
}

$("liveBtn").onclick = () => { if (!me) return; mode === "host" ? endLive() : mode === "view" ? leave() : startLive(); };

// ---------- Called from script.js when someone logs in or out ----------
export function initLive(user) {
  me = user;
  unsubList && unsubList();
  unsubList = F.onSnapshot(F.collection(db, "lives"), s => { lives = s.docs.map(d => ({ id: d.id, ...d.data() })); renderList(); });
  clearInterval(listTimer); listTimer = setInterval(renderList, 15000);   // drop lives that went quiet
  ui(); renderList();
}
export function stopLive() {
  mode === "host" ? endLive() : cleanup();
  unsubList && unsubList(); unsubList = null; clearInterval(listTimer);
  lives = []; me = null; list.innerHTML = "";
}
