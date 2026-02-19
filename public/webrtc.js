// Basic WebRTC + Socket.IO signaling for 1:1 calls

const statusText = document.getElementById('status-text');
const roomLabel = document.getElementById('room-label'); // May not exist in simplified UI
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
const iceDescEl = document.getElementById('ice-desc'); // May not exist in simplified UI

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
  if (iceDescEl) {
    iceDescEl.textContent = 'STUN only (replace with TURN in prod)';
  }
  return [
    { urls: 'stun:stun.l.google.com:19302' }
  ];
})();

function updateStatus(text) {
  statusText.textContent = text;
}

function setRoomLabel(roomId) {
  if (roomLabel) {
    roomLabel.textContent = roomId ? `room: ${roomId}` : '';
  }
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
    // Enhanced audio constraints for aggressive echo cancellation
    // Enable all processing features to prevent echo while maintaining voice quality
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // Chrome/Edge specific enhanced echo cancellation
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      googTypingNoiseDetection: true,
      googNoiseReduction: true,
      // Acoustic echo cancellation mode (more aggressive)
      googEchoCancellation2: true,
      googDAEchoCancellation: true,  // Double-talk aware echo cancellation
      // Mobile-specific optimizations
      channelCount: 1,
      sampleRate: 48000,
      latency: 0.01,
      sampleSize: 16,
      // Additional echo reduction
      suppressLocalAudioPlayback: true  // Prevents local audio from being captured
    };

    // Ensure local video is always muted to prevent feedback
    if (localVideo) {
      localVideo.muted = true;
    }

    // Mobile-optimized video constraints
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const videoConstraints = audioOnly
      ? false
      : isMobile
      ? {
          // Lower resolution for mobile to save bandwidth and improve performance
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: 'user' // Front camera on mobile
        }
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

    // Verify and enforce echo cancellation on audio tracks
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach((track) => {
      const settings = track.getSettings();
      console.log('Audio track settings:', {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount
      });
      
      // Aggressively enforce echo cancellation constraints
      const enforcedConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        googEchoCancellation: true,
        googDAEchoCancellation: true
      };
      
      track.applyConstraints(enforcedConstraints).catch((err) => {
        console.warn('Could not apply all audio constraints, trying basic set:', err);
        // Fallback to basic echo cancellation
        track.applyConstraints({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }).catch((fallbackErr) => {
          console.warn('Could not apply basic audio constraints:', fallbackErr);
        });
      });
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
    
    // Mobile-specific: Set audio output to speaker/earpiece appropriately
    if (remoteVideo.setSinkId && 'setSinkId' in remoteVideo) {
      // On mobile, prefer speaker for better call quality
      // This helps prevent echo by routing audio away from the microphone
      remoteVideo.setSinkId('').catch((err) => {
        console.log('Could not set audio sink (may not be supported):', err);
      });
    }
    
    // Ensure audio plays through the correct output device
    remoteVideo.volume = 1.0;
    
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
  try {
    console.log('joinRoom called');
    let roomId = roomInput.value.trim();
    if (!roomId) {
      roomId = genRandomRoomId();
      roomInput.value = roomId;
    }
    console.log('Room ID:', roomId);

    setupSocketIfNeeded();
    console.log('Socket setup complete');
    
    await ensureLocalStream();
    console.log('Local stream obtained');

    currentRoomId = roomId;
    setRoomLabel(roomId);
    setRoomIdInURL(roomId);

    updateStatus('Joining room…');
    socket.emit('join', roomId);
    console.log('Emitted join event for room:', roomId);

    joinBtn.disabled = true;
    leaveBtn.disabled = false;
  } catch (err) {
    console.error('Error in joinRoom:', err);
    updateStatus('Failed to join room: ' + err.message);
    throw err;
  }
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
  console.log('Join button clicked');
  joinRoom().catch((err) => {
    console.error('Error joining room:', err);
    updateStatus('Error joining room. Check console for details.');
  });
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
  // Verify critical elements exist
  if (!joinBtn) {
    console.error('Join button not found!');
    return;
  }
  if (!roomInput) {
    console.error('Room input not found!');
    return;
  }
  if (!statusText) {
    console.error('Status text element not found!');
    return;
  }
  
  console.log('Page loaded, initializing...');
  const roomFromURL = getRoomIdFromURL();
  if (roomFromURL) {
    roomInput.value = roomFromURL;
    updateStatus('Ready. Click "Join" to enter the room from URL.');
    setRoomLabel(roomFromURL);
  } else {
    updateStatus('Idle. Choose a room to start.');
  }
  showVideoPlaceholders();
});


