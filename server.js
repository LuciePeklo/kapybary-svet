const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
const rooms = new Map();
const socketRoom = new Map();
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(__dirname + '/index.html'));

function newPin() {
  let pin;
  do { pin = String(crypto.randomInt(100000, 1000000)); } while (rooms.has(pin));
  return pin;
}
function cleanName(value, fallback) {
  return String(value || fallback).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || fallback;
}
function leave(socket) {
  const pin = socketRoom.get(socket.id);
  if (!pin) return;
  socketRoom.delete(socket.id);
  const room = rooms.get(pin);
  if (!room) return;
  if (room.hostId === socket.id) {
    io.to(pin).emit('host-left');
    for (const id of room.pending.keys()) socketRoom.delete(id);
    rooms.delete(pin);
    return;
  }
  room.pending.delete(socket.id);
  const playerId = room.players.get(socket.id);
  room.players.delete(socket.id);
  if (playerId !== undefined) {
    socket.to(pin).emit('player-left', { playerId });
    socket.to(room.hostId).emit('player-left', { playerId });
  }
}

io.on('connection', socket => {
  socket.on('create-room', data => {
    leave(socket);
    const pin = newPin();
    const room = { hostId: socket.id, hostName: cleanName(data && data.name, 'Hostitel'), pending: new Map(), players: new Map([[socket.id, 0]]) };
    rooms.set(pin, room);
    socketRoom.set(socket.id, pin);
    socket.join(pin);
    socket.emit('room-created', { pin });
  });

  socket.on('join-room', data => {
    const pin = String(data && data.pin || '').replace(/\D/g, '').slice(0, 6);
    const room = rooms.get(pin);
    if (!room || pin.length !== 6) { socket.emit('player-denied'); return; }
    if (room.pending.has(socket.id) || room.players.has(socket.id)) return;
    if (room.players.size + room.pending.size >= MAX_PLAYERS) { socket.emit('room-full'); return; }
    const name = cleanName(data && data.name, 'Hráč');
    room.pending.set(socket.id, { name, requestedAt: Date.now() });
    socketRoom.set(socket.id, pin);
    io.to(room.hostId).emit('join-request', { id: socket.id, name });
    socket.emit('join-pending');
  });

  socket.on('approve-player', data => {
    const pin = socketRoom.get(socket.id);
    const room = pin && rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    const id = String(data && data.id || '');
    const request = room.pending.get(id);
    const target = io.sockets.sockets.get(id);
    if (!request || !target || room.players.size >= MAX_PLAYERS) return;
    room.pending.delete(id);
    let playerId = 1;
    const used = new Set(room.players.values());
    while (used.has(playerId) && playerId < MAX_PLAYERS) playerId++;
    if (playerId >= MAX_PLAYERS) return;
    room.players.set(id, playerId);
    target.join(pin);
    target.emit('player-approved', { playerId });
    io.to(room.hostId).emit('player-joined', { playerId, name: request.name });
  });

  socket.on('deny-player', data => {
    const pin = socketRoom.get(socket.id);
    const room = pin && rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    const id = String(data && data.id || '');
    if (!room.pending.has(id)) return;
    room.pending.delete(id);
    socketRoom.delete(id);
    const target = io.sockets.sockets.get(id);
    if (target) target.emit('player-denied');
  });

  socket.on('player-input', data => {
    const pin = socketRoom.get(socket.id);
    const room = pin && rooms.get(pin);
    if (!room || room.hostId === socket.id || !room.players.has(socket.id)) return;
    const raw = data && data.keys || {};
    const keys = { w: !!raw.w, a: !!raw.a, s: !!raw.s, d: !!raw.d };
    io.to(room.hostId).emit('input-from-player', { playerId: room.players.get(socket.id), keys });
  });

  socket.on('game-state', data => {
    const pin = socketRoom.get(socket.id);
    const room = pin && rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    // Only the host can publish game state to approved room members.
    const state = {
      players: Array.isArray(data && data.players) ? data.players.slice(0, MAX_PLAYERS) : [],
      trees: Array.isArray(data && data.trees) ? data.trees.slice(0, 100) : [],
      carrots: Array.isArray(data && data.carrots) ? data.carrots.slice(0, 100) : [],
      fish: Array.isArray(data && data.fish) ? data.fish.slice(0, 100) : [],
      settings: data && data.settings || {}, paused: !!(data && data.paused),
      running: !!(data && data.running), names: data && data.names || {}
    };
    socket.to(pin).emit('game-state', state);
  });

  socket.on('disconnect', () => leave(socket));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Kapybara svět běží na portu ${PORT}`));
