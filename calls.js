// Voice and video calls between two users (WebRTC).
// Firebase only helps the two phones find each other; the call itself goes phone to phone.
import { db, F } from "./firebase.js";

// STUN servers help each phone discover its public address.
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };

let pc = null, local = null, subs = [], active = null, timer = null, incoming = null;
const seen = new Set();   // calls we already answered or declined

// ---------- Call screens (built here so no HTML changes are needed) ----------
const box = document.createElement("div");
box.hidden = true;
box.style.cssText = "position:fixed;inset:0;z-index:30;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px";
box.innerHTML = `
  <h2 id="cbWho" style="font:600 1.2rem system-ui"></h2>
  <p id="cbState" style="opacity:.7"></p>
  <video id="cbRemote" autoplay playsinline style="width:100%;max-width:520px;max-height:60vh;background:#111;border-radius:14px"></video>
  <video id="cbLocal" autoplay muted playsinline style="position:absolute;right:14px;bottom:110px;width:90px;border-radius:10px;background:#222"></video>
  <div style="display:flex;gap:12px">
    <button id="cbMute" style="padding:12px 18px;border-radius:24px;border:0">Mute</button>
    <button id="cbEnd" style="padding:12px 22px;border-radius:24px;border:0;background:#d93b3b;color:#fff">End call</button>
  </div>`;

const ring = document.createElement("div");
ring.hidden = true;
ring.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:31;background:#1b2a41;color:#fff;padding:14px;display:flex;gap:10px;align-items:center";
ring.innerHTML = `
  <span id="cbRingText" style="flex:1"></span>
  <button id="cbAccept" style="padding:10px 16px;border-radius:20px;border:0;background:#2bb673;color:#fff">Accept</button>
  <button id="cbDecline" style="padding:10px 16px;border-radius:20px;border:0;background:#d93b3b;color:#fff">Decline</button>`;

document.body.append(box, ring);
const $ = id => document.getElementById(id);

const callRef = (chatId, callId) => F.doc(db, "chats", chatId, "calls", callId);
const candidates = (chatId, callId, name) => F.collection(db, "chats", chatId, "calls", callId, name);
const addCandidates = (snap) => snap.docChanges().forEach(ch => ch.type === "added" && pc && pc.addIceCandidate(ch.doc.data()));

// ---------- Shared setup: microphone/camera and the connection ----------
async function setup(chatId, callId, video, role, name) {
  local = await navigator.mediaDevices.getUserMedia({ audio: true, video });
  pc = new RTCPeerConnection(ICE);
  local.getTracks().forEach(t => pc.addTrack(t, local));

  const remote = new MediaStream();
  pc.ontrack = e => e.streams[0].getTracks().forEach(t => remote.addTrack(t));
  $("cbRemote").srcObject = remote;
  $("cbLocal").srcObject = local; $("cbLocal").hidden = !video;

  // Each connection route we discover is saved so the other phone can try it
  pc.onicecandidate = e => e.candidate && F.addDoc(candidates(chatId, callId, role + "Candidates"), e.candidate.toJSON());
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === "connected") $("cbState").textContent = "Connected";
    if (pc.connectionState === "failed") $("cbState").textContent = "Could not connect. Try Wi-Fi.";
  };

  $("cbWho").textContent = name; $("cbState").textContent = "Connecting...";
  box.hidden = false; active = { chatId, callId };
}

function finish() {
  clearTimeout(timer);
  subs.forEach(f => f()); subs = [];
  local && local.getTracks().forEach(t => t.stop());
  pc && pc.close();
  pc = null; local = null; active = null; box.hidden = true;
}

async function hangUp() {
  const a = active; finish();
  if (!a) return;
  try {
    await F.updateDoc(callRef(a.chatId, a.callId), { status: "ended" });
    await F.updateDoc(F.doc(db, "chats", a.chatId), { call: null });
  } catch (e) {}
}

// ---------- Calling someone ----------
export async function startCall({ chat, me, video, name }) {
  if (!chat) return;
  if (active) return alert("You are already in a call.");
  const callId = String(Date.now());
  try {
    await setup(chat.id, callId, video, "caller", name);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await F.setDoc(callRef(chat.id, callId), { from: me.uid, video, offer: { type: offer.type, sdp: offer.sdp }, status: "ringing" });
    // This tells the other person's app that a call is coming in
    await F.updateDoc(F.doc(db, "chats", chat.id), { call: { id: callId, from: me.uid, fromName: me.username, video, time: Date.now() } });
    $("cbState").textContent = "Ringing...";

    subs.push(F.onSnapshot(callRef(chat.id, callId), async s => {
      const d = s.data(); if (!d || !pc) return;
      if (d.status === "ended") return finish();
      if (d.answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(d.answer);
        subs.push(F.onSnapshot(candidates(chat.id, callId, "calleeCandidates"), addCandidates));
      }
    }));
    timer = setTimeout(() => { if (pc && !pc.currentRemoteDescription) { alert("No answer."); hangUp(); } }, 45000);
  } catch (e) { alert("Call failed: " + e.message); hangUp(); }
}

// ---------- Receiving a call (script.js calls this whenever the chat list changes) ----------
export function onChats(chats, me, isBlocked) {
  if (incoming) {
    const still = chats.find(c => c.id === incoming.chat.id);
    if (!still || !still.call) { ring.hidden = true; incoming = null; }   // caller gave up
  }
  if (active || incoming) return;
  const c = chats.find(x => x.call && x.call.from !== me.uid && Date.now() - x.call.time < 45000 && !seen.has(x.call.id) && !isBlocked(x));
  if (!c) return;
  incoming = { chat: c, call: c.call };
  $("cbRingText").textContent = (c.call.video ? "Video" : "Voice") + " call from " + c.call.fromName;
  ring.hidden = false;
}

$("cbAccept").onclick = async () => {
  const { chat, call } = incoming; ring.hidden = true; incoming = null; seen.add(call.id);
  try {
    const d = (await F.getDoc(callRef(chat.id, call.id))).data();
    if (!d || d.status === "ended") throw new Error("The call already ended.");
    await setup(chat.id, call.id, call.video, "callee", call.fromName);
    await pc.setRemoteDescription(d.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await F.updateDoc(callRef(chat.id, call.id), { answer: { type: answer.type, sdp: answer.sdp }, status: "active" });
    subs.push(F.onSnapshot(candidates(chat.id, call.id, "callerCandidates"), addCandidates));
    subs.push(F.onSnapshot(callRef(chat.id, call.id), s => { const x = s.data(); if (x && x.status === "ended") finish(); }));
  } catch (e) { alert("Could not join the call: " + e.message); hangUp(); }
};

$("cbDecline").onclick = async () => {
  const { chat, call } = incoming; ring.hidden = true; incoming = null; seen.add(call.id);
  try {
    await F.updateDoc(callRef(chat.id, call.id), { status: "ended" });
    await F.updateDoc(F.doc(db, "chats", chat.id), { call: null });
  } catch (e) {}
};

$("cbEnd").onclick = hangUp;
$("cbMute").onclick = () => {
  if (!local) return;
  const t = local.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $("cbMute").textContent = t.enabled ? "Mute" : "Unmute";
};
