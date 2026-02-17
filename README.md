## VideoCallls MVP – self-hosted WebRTC call link

This is a minimal **WebRTC audio/video calling MVP**:

- **Backend**: Node.js + Express + Socket.IO for signaling (create/join rooms, exchange SDP/ICE).
- **Frontend**: Single HTML page that runs in the browser and sets up a 1:1 WebRTC call.
- **Goal**: You self-host everything, then later a Telegram bot can generate links like  
  `https://your-domain/?room=team-standup`, without using Telegram's own video API.

### 1. Install & run locally

From the project root:

```bash
cd /Users/g.dvoryak/Desktop/videocallls
npm install
npm run dev   # or: npm start
```

The server listens on `http://localhost:3000`.

Then:

1. Open `http://localhost:3000` in Browser A (Chrome/Edge/Firefox).
2. Choose a **room ID** (e.g. `test-123`) and click **“Start / join call”**.
3. Copy the link (or the full URL with `?room=test-123`) and open it in Browser B  
   (another browser, or same browser in incognito / another device).

You should see:

- Your local camera preview on the left.
- Remote video on the right, once the second side joins.
- Buttons to mute/unmute mic, stop/start video, and leave call.

### 2. Architecture overview

- **Signaling server (`server.js`)**
  - Serves static files from `public/`.
  - Manages simple **rooms** in memory (`roomId` → set of socket IDs).
  - Handles:
    - `join(roomId)`: join socket.io room + return existing peers.
    - `signal({ roomId, targetId, data })`:
      - If `targetId` set → send offer/answer directly.
      - If `targetId` absent → broadcast ICE candidates to everyone else in the room.
    - `leave(roomId)` / `disconnect`: remove from room and notify others via `peer-left`.

- **Frontend (`public/index.html` + `public/webrtc.js`)**
  - UI for entering room ID, toggling audio-only mode, and controlling mic/camera.
  - Uses `navigator.mediaDevices.getUserMedia` to get audio/video.
  - Uses `RTCPeerConnection` with configurable `iceServers` for SDP / ICE.
  - Uses Socket.IO to:
    - Join a room.
    - Exchange SDP offer/answer and ICE candidates.

### 3. Adapting for Russia (STUN/TURN / routing)

Right now the browser uses only a **public STUN server**:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }
];
```

For real-world reliability from Russia you should:

- Deploy your own **TURN** (e.g. `coturn`) on infrastructure that works reliably in- and out-of-country.
- Replace the `ICE_SERVERS` array in `public/webrtc.js` with something like:

```js
const ICE_SERVERS = [
  { urls: 'stun:your-stun.yourdomain.ru:3478' },
  {
    urls: 'turn:your-turn.yourdomain.ru:3478',
    username: 'user',
    credential: 'password'
  }
];
```

Later, you can:

- Protect access with auth tokens.
- Issue **per-call TURN credentials** from your backend.

### 4. Next step: Telegram bot (concept)

Once this is deployed on a public URL (say `https://calls.yourdomain.ru`), the flow for Telegram:

1. User writes `/call` to the bot.
2. Bot backend generates `roomId` (e.g. `call-<user>-<timestamp>`).
3. Bot sends back a link: `https://calls.yourdomain.ru/?room=call-abc123`.
4. Clicking the link opens this WebRTC UI in the browser – all media flows through your infra, not Telegram.

We can wire this bot on top of the current code without changing the call logic.


