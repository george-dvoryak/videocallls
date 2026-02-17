require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Basic in-memory room tracking (for MVP only)
const rooms = new Map(); // roomId -> Set<socket.id>

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (roomId) => {
    if (!roomId) return;

    socket.join(roomId);

    let room = rooms.get(roomId);
    if (!room) {
      room = new Set();
      rooms.set(roomId, room);
    }

    room.add(socket.id);
    console.log(`Socket ${socket.id} joined room ${roomId}`);

    // Notify existing peers about the new participant
    socket.to(roomId).emit('peer-joined', { socketId: socket.id });

    // Send back current peers in the room to the new participant
    const existingPeers = Array.from(room).filter((id) => id !== socket.id);
    socket.emit('room-info', { peers: existingPeers });
  });

  // WebRTC signaling messages
  socket.on('signal', ({ roomId, targetId, data }) => {
    if (!roomId || !data) return;

    // If a specific peer is targeted (offer/answer), send directly
    if (targetId) {
      io.to(targetId).emit('signal', {
        from: socket.id,
        data
      });
      return;
    }

    // Otherwise broadcast to the rest of the room (used for ICE candidates)
    socket.to(roomId).emit('signal', {
      from: socket.id,
      data
    });
  });

  socket.on('leave', (roomId) => {
    if (!roomId) return;
    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.delete(socket.id);
    socket.leave(roomId);

    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      socket.to(roomId).emit('peer-left', { socketId: socket.id });
    }
  });

  socket.on('disconnecting', () => {
    const roomsForSocket = socket.rooms;
    for (const roomId of roomsForSocket) {
      if (roomId === socket.id) continue;

      const room = rooms.get(roomId);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(roomId);
        } else {
          socket.to(roomId).emit('peer-left', { socketId: socket.id });
        }
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT}`);
});


