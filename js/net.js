// Networking: PeerJS-based host-relay multiplayer.
//
// The host is the only peer everyone else connects to (a star, not a full
// mesh), so this scales to several joiners without the connection count
// exploding. Each participant fully simulates only its own kart locally
// (so input feels instant) and sends that kart's state to the host a few
// times a second; the host aggregates every kart's state (its own, any
// AI filling empty slots, and every connected client's) and rebroadcasts
// the full snapshot to all clients, who apply it directly to every kart
// except their own.
//
// This all runs over a free public signaling broker (PeerJS's hosted
// service) with no dedicated relay/TURN server behind it. Most home and
// mobile connections establish fine, but some networks (strict corporate
// firewalls, certain carrier-grade NAT setups) simply cannot punch through
// on the free tier with no fallback. Failures are surfaced, never hidden.

const NET_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids look-alike mistakes when read aloud
const NET_PEER_PREFIX = 'kartrush-';
const NET_MAX_SLOTS = 4;
// A clean tab close/network drop doesn't always fire a 'close' event
// promptly — WebRTC's own dead-connection detection can take many seconds.
// A heartbeat catches it fast regardless of *how* the connection died.
const NET_HEARTBEAT_TIMEOUT_MS = 4000;
const NET_HEARTBEAT_CHECK_MS = 1500;
const NET_PING_INTERVAL_MS = 1000;

function generateRaceCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += NET_CODE_CHARS[Math.floor(Math.random() * NET_CODE_CHARS.length)];
  return code;
}

function netErrorMessage(err) {
  const type = err && err.type;
  if (type === 'peer-unavailable') return "That race code doesn't exist. Check it and try again.";
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'Network error reaching the matchmaking service — check your connection and try again.';
  }
  if (type === 'browser-incompatible') return "This browser doesn't support what multiplayer needs.";
  if (type === 'unavailable-id') return 'That code is already taken. Try again.';
  return "Couldn't connect. Try again.";
}

class NetSession {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.myKartIndex = 0;
    this.clientConns = []; // host only: [{ conn, kartIndex }]
    this.hostConn = null; // client only
    this.code = null;

    this.onPlayerJoined = null; // (kartIndex) => void
    this.onPlayerLeft = null; // (kartIndex) => void
    this.onSnapshot = null; // (kartsState[]) => void  — client only
    this.onHostState = null; // (kartIndex, state) => void — host only
    this.onPlayerColor = null; // (kartIndex, colorHex) => void — host only
    this.onConnected = null; // (myKartIndex) => void — client only
    this.onError = null; // (message) => void
    this.onHostStart = null; // (colors) => void — client only, colors: {kartIndex: hex}
    this.onHostReady = null; // (code) => void — host only, fires once the code is live
  }

  host(attemptsLeft = 5) {
    if (attemptsLeft <= 0) { this.onError && this.onError('Could not get a race code. Try again.'); return; }
    const code = generateRaceCode();
    const peer = new Peer(NET_PEER_PREFIX + code, { debug: 0 });
    this.peer = peer;
    this.isHost = true;
    this.myKartIndex = 0;

    peer.on('open', () => { this.code = code; this.onHostReady && this.onHostReady(code); });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); this.host(attemptsLeft - 1); return; }
      this.onError && this.onError(netErrorMessage(err));
    });
    peer.on('connection', (conn) => {
      const usedSlots = new Set(this.clientConns.map(c => c.kartIndex));
      let slot = -1;
      for (let i = 1; i < NET_MAX_SLOTS; i++) { if (!usedSlots.has(i)) { slot = i; break; } }

      conn.on('open', () => {
        if (slot === -1) {
          conn.send({ type: 'full' });
          setTimeout(() => conn.close(), 300);
          return;
        }
        const entry = { conn, kartIndex: slot, lastSeen: Date.now() };
        this.clientConns.push(entry);
        conn.send({ type: 'welcome', kartIndex: slot });
        this.onPlayerJoined && this.onPlayerJoined(slot);
      });
      conn.on('data', (data) => {
        if (slot === -1) return;
        const entry = this.clientConns.find(c => c.conn === conn);
        if (entry) entry.lastSeen = Date.now(); // any message counts, not just 'state' — see the ping below
        if (data.type === 'state') this.onHostState && this.onHostState(slot, data.state);
        else if (data.type === 'color') this.onPlayerColor && this.onPlayerColor(slot, data.color);
      });
      conn.on('close', () => this._dropClient(conn, slot));
    });

    this._heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const entry of [...this.clientConns]) {
        if (now - entry.lastSeen > NET_HEARTBEAT_TIMEOUT_MS) this._dropClient(entry.conn, entry.kartIndex);
      }
    }, NET_HEARTBEAT_CHECK_MS);
  }

  _dropClient(conn, slot) {
    if (slot === -1 || !this.clientConns.some(c => c.conn === conn)) return;
    this.clientConns = this.clientConns.filter(c => c.conn !== conn);
    try { conn.close(); } catch (e) { /* already gone */ }
    this.onPlayerLeft && this.onPlayerLeft(slot);
  }

  join(code, timeoutMs = 8000) {
    const peer = new Peer(undefined, { debug: 0 });
    this.peer = peer;
    this.isHost = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.onError && this.onError("Couldn't connect to that race code. Check it and try again.");
      peer.destroy();
    }, timeoutMs);

    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    peer.on('open', () => {
      const conn = peer.connect(NET_PEER_PREFIX + code.toUpperCase(), { reliable: false });
      this.hostConn = conn;
      conn.on('data', (data) => {
        if (data.type === 'welcome') {
          finish(() => {
            this.myKartIndex = data.kartIndex;
            this.code = code.toUpperCase();
            // Keeps the host's heartbeat alive through the lobby wait and
            // countdown, when no real 'state' messages are sent yet.
            this._pingInterval = setInterval(() => {
              if (this.hostConn && this.hostConn.open) this.hostConn.send({ type: 'ping' });
            }, NET_PING_INTERVAL_MS);
            this.onConnected && this.onConnected(data.kartIndex);
          });
        } else if (data.type === 'full') {
          finish(() => { this.onError && this.onError('That race is already full.'); peer.destroy(); });
        } else if (data.type === 'snapshot') {
          this.onSnapshot && this.onSnapshot(data.karts, data.humanSlots);
        } else if (data.type === 'start') {
          this.onHostStart && this.onHostStart(data.colors);
        }
      });
      conn.on('close', () => { if (settled) this.onError && this.onError('Lost connection to the host.'); });
      conn.on('error', (err) => finish(() => { this.onError && this.onError(netErrorMessage(err)); }));
    });
    peer.on('error', (err) => finish(() => { this.onError && this.onError(netErrorMessage(err)); }));
  }

  sendState(state) {
    if (this.hostConn && this.hostConn.open) this.hostConn.send({ type: 'state', state });
  }

  sendColor(colorHex) {
    if (this.hostConn && this.hostConn.open) this.hostConn.send({ type: 'color', color: colorHex });
  }

  broadcastSnapshot(kartsState, humanSlots) {
    for (const { conn } of this.clientConns) {
      if (conn.open) conn.send({ type: 'snapshot', karts: kartsState, humanSlots });
    }
  }

  broadcastStart(colors) {
    for (const { conn } of this.clientConns) {
      if (conn.open) conn.send({ type: 'start', colors });
    }
  }

  disconnect() {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    this._heartbeatInterval = null;
    if (this._pingInterval) clearInterval(this._pingInterval);
    this._pingInterval = null;
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.clientConns = [];
    this.hostConn = null;
    this.code = null;
  }
}
