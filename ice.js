// Gets the relay (TURN) servers so calls and lives also work on mobile data and strict networks.
const TURN_URL = "https://chatterbox-bife.metered.live/api/v1/turn/credentials?apiKey=ba8e3fdc32c07c53754d5453d863c67bb242";

// STUN servers help phones find each other directly (free, no sign-up)
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

let cache = null, cachedAt = 0;

export async function getIce() {
  if (cache && Date.now() - cachedAt < 3600000) return cache;   // reuse for one hour
  let relays = [];
  if (TURN_URL.startsWith("https://")) {
    try {
      const r = await fetch(TURN_URL);
      if (r.ok) relays = await r.json();
    } catch (e) { console.warn("Relay servers not available, using direct connections only.", e); }
  }
  const config = { iceServers: [...STUN, ...relays] };
  if (relays.length) { cache = config; cachedAt = Date.now(); }
  return config;
}