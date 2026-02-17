// Basic WebRTC + Socket.IO signaling for 1:1 calls

const statusText = document.getElementById('status-text');
const roomLabel = document.getElementById('room-label');
const roomInput = document.getElementById('room-id');
const audioOnlyCheckbox = document.getElementById('audio-only');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const copyLinkBtn = document.getElementById('copy-link');
const toggleMicBtn = document.getElementById('toggle-mic');
const toggleCameraBtn = document.getElementById('toggle-camera');

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const localPlaceholder = document.getElementById('local-placeholder');
const remotePlaceholder = document.getElementById('remote-placeholder');
const iceDescEl = document.getElementById('ice-desc');

let socket;
let currentRoomId = null;
let localStream = null;
let peerConnection = null;
let isCaller = false;

// Configure ICE servers.
// In production you should point this at TURN servers you control in your region.
const ICE_SERVERS = (() => {
  const fromEnv = window.ICE_SERVERS_OVERRIDE; // can be injected server-side if needed
  if (Array.isArray(fromEnv) && fromEnv.length) return fromEnv;
  // Default minimal config – replace with your own TURN infra for Russia
  iceDescEl.textContent = 'STUN only (replace with TURN in prod)';
  return [
    { urls: 'stun:stun.l.google.com:19302' }
  ];
})();

function updateStatus(text) {
  statusText.textContent = text;
}

function setRoomLabel(roomId) {
  roomLabel.textContent = roomId ? `room: ${roomId}` : '';
}

function getRoomIdFromURL() {
  const url = new URL(window.location.href);
  return url.searchParams.get('room') || '';
}

function setRoomIdInURL(roomId) {
  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set('room', roomId);
  } else {
    url.searchParams.delete('room');
  }
  window.history.replaceState({}, '', url.toString());
}

function genRandomRoomId() {
  const base = Math.random().toString(36).slice(2, 8);
  return `room-${base}`;
}

function enableCallControls(enabled) {
  leaveBtn.disabled = !enabled;
  toggleMicBtn.disabled = !enabled;
  toggleCameraBtn.disabled = !enabled;
}

function showVideoPlaceholders() {
  if (localPlaceholder) localPlaceholder.style.display = localStream ? 'none' : 'block';
  if (remotePlaceholder) remotePlaceholder.style.display = remoteVideo.srcObject ? 'none' : 'block';
}

function setupSocketIfNeeded() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
  });

  socket.on('room-info', async ({ peers }) => {
    console.log('Room info, peers:', peers);
    // If there is already someone in the room, start negotiation as caller
    if (peers && peers.length > 0 && !peerConnection) {
      isCaller = true;
      await ensurePeerConnection();
      await makeOffer(peers[0]);
    }
  });

  socket.on('peer-joined', ({ socketId }) => {
    console.log('Peer joined room:', socketId);
    // For simplicity we only support 1:1, so nothing to do here
  });

  socket.on('peer-left', ({ socketId }) => {
    console.log('Peer left room:', socketId);
    if (remoteVideo.srcObject) {
      remoteVideo.srcObject = null;
      showVideoPlaceholders();
    }
    updateStatus('Remote participant left. Waiting for someone to join.');
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) {
      await ensurePeerConnection();
    }

    if (data.type === 'offer') {
      console.log('Received offer from', from);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendSignal({ targetId: from, data: peerConnection.localDescription });
    } else if (data.type === 'answer') {
      console.log('Received answer from', from);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Error adding received ICE candidate', err);
      }
    }
  });
}

function sendSignal({ targetId, data }) {
  if (!socket || !currentRoomId) return;
  socket.emit('signal', { roomId: currentRoomId, targetId, data });
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  const audioOnly = audioOnlyCheckbox.checked;
  try {
    // Enhanced audio constraints for better echo cancellation
    // Enable all processing features to prevent echo while maintaining voice quality
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,  // Re-enabled for better echo reduction
      autoGainControl: true,   // Re-enabled to normalize volume
      googEchoCancellation: true,  // Chrome-specific enhanced echo cancellation
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,   // Filter out low-frequency noise
      googTypingNoiseDetection: true,  // Reduce keyboard noise
      channelCount: 1,
      sampleRate: 48000,
      // Additional constraints for better echo handling
      latency: 0.01,  // Low latency for real-time communication
      sampleSize: 16
    };

    // Ensure local video is always muted to prevent feedback
    if (localVideo) {
      localVideo.muted = true;
    }

    const videoConstraints = audioOnly
      ? false
      : {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 }
        };

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints
      });
    } catch (err) {
      // Fallback: try with simpler constraints if enhanced ones fail
      console.warn('Enhanced audio constraints failed, trying fallback:', err);
      const fallbackAudioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
      };
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: fallbackAudioConstraints,
        video: videoConstraints
      });
    }

    // Verify echo cancellation is enabled on audio tracks
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach((track) => {
      const settings = track.getSettings();
      console.log('Audio track settings:', {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl
      });
      
      // Force enable echo cancellation if not already enabled
      if (track.getConstraints) {
        track.applyConstraints({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }).catch((err) => {
          console.warn('Could not apply audio constraints:', err);
        });
      }
    });

    localVideo.srcObject = localStream;
    // Ensure local video stays muted to prevent echo
    localVideo.muted = true;
    showVideoPlaceholders();
    enableCallControls(true);
    updateStatus(audioOnly ? 'Joined with audio only.' : 'Camera + mic active.');
    return localStream;
  } catch (err) {
    console.error('Error accessing media devices', err);
    updateStatus('Cannot access camera/mic. Check permissions.');
    throw err;
  }
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;

  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket && currentRoomId) {
      // In 1:1 scenario, we don't know peer ID here; signaling handler passes correct target
      // We handle ICE via negotiated target from offer/answer phase
      // For simplicity, we send ICE to "other side" inferred from `isCaller`.
      // This is MVP; for multi-party you'd track explicit peer IDs.
      const candidate = event.candidate;
      socket.emit('signal', {
        roomId: currentRoomId,
        targetId: null, // handled on server by broadcasting to room except sender
        data: { candidate }
      });
    }
  };

  peerConnection.ontrack = (event) => {
    console.log('Got remote track');
    const remoteStream = event.streams[0];
    remoteVideo.srcObject = remoteStream;
    
    // Ensure remote video is NOT muted (so you can hear the other person)
    // and local video stays muted (to prevent echo)
    remoteVideo.muted = false;
    if (localVideo) {
      localVideo.muted = true;
    }
    
    showVideoPlaceholders();
  };

  const stream = await ensureLocalStream();
  for (const track of stream.getTracks()) {
    peerConnection.addTrack(track, stream);
  }

  // Tune media send parameters for better perceived quality
  try {
    const senders = peerConnection.getSenders();
    senders.forEach((sender) => {
      if (!sender.track) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) {
        params.encodings = [{}];
      }
      const encoding = params.encodings[0];

      if (sender.track.kind === 'video') {
        // Target up to ~1.2 Mbps video; browser will adapt down if needed
        encoding.maxBitrate = 1_200_000; // in bits per second
      } else if (sender.track.kind === 'audio') {
        // Slightly higher audio bitrate for more stable voice
        encoding.maxBitrate = 128_000;
      }

      sender.setParameters(params).catch((err) => {
        console.warn('Failed to apply RTP sender parameters', err);
      });
    });
  } catch (err) {
    console.warn('Error tuning sender parameters', err);
  }

  return peerConnection;
}

async function makeOffer(targetId) {
  if (!peerConnection) await ensurePeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  sendSignal({ targetId, data: offer });
  updateStatus('Calling remote peer...');
}

async function joinRoom() {
  let roomId = roomInput.value.trim();
  if (!roomId) {
    roomId = genRandomRoomId();
    roomInput.value = roomId;
  }

  setupSocketIfNeeded();
  await ensureLocalStream();

  currentRoomId = roomId;
  setRoomLabel(roomId);
  setRoomIdInURL(roomId);

  updateStatus('Joining room…');
  socket.emit('join', roomId);

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
}

function leaveRoom() {
  if (socket && currentRoomId) {
    socket.emit('leave', currentRoomId);
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  currentRoomId = null;
  isCaller = false;

  enableCallControls(false);
  joinBtn.disabled = false;
  setRoomLabel('');
  setRoomIdInURL('');
  showVideoPlaceholders();
  updateStatus('Left call. You can start a new room.');
}

function toggleMic() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (!audioTracks.length) return;
  const enabled = !audioTracks[0].enabled;
  audioTracks.forEach((t) => {
    t.enabled = enabled;
  });
  toggleMicBtn.textContent = enabled ? 'Mute' : 'Unmute';
}

function toggleCamera() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if (!videoTracks.length) return;
  const enabled = !videoTracks[0].enabled;
  videoTracks.forEach((t) => {
    t.enabled = enabled;
  });
  toggleCameraBtn.textContent = enabled ? 'Stop video' : 'Start video';
}

async function copyRoomLink() {
  let roomId = roomInput.value.trim();
  if (!roomId) {
    roomId = genRandomRoomId();
    roomInput.value = roomId;
  }
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  try {
    await navigator.clipboard.writeText(url.toString());
    updateStatus('Room link copied. Send it to the other participant.');
  } catch (err) {
    console.error('Failed to copy link', err);
    updateStatus('Cannot copy to clipboard. Copy URL from address bar.');
  }
}

joinBtn.addEventListener('click', () => {
  joinRoom().catch((err) => console.error(err));
});

leaveBtn.addEventListener('click', () => {
  leaveRoom();
});

toggleMicBtn.addEventListener('click', () => {
  toggleMic();
});

toggleCameraBtn.addEventListener('click', () => {
  toggleCamera();
});

copyLinkBtn.addEventListener('click', () => {
  copyRoomLink();
});

// Initialize from URL room if present
window.addEventListener('load', () => {
  const roomFromURL = getRoomIdFromURL();
  if (roomFromURL) {
    roomInput.value = roomFromURL;
    updateStatus('Ready. Click "Start / join call" to enter the room from URL.');
    setRoomLabel(roomFromURL);
  } else {
    updateStatus('Idle. Choose a room ID to start.');
  }
  showVideoPlaceholders();
});


