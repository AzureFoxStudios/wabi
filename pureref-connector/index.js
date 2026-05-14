const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');

// --- Configuration ---
// In a real app, this would come from a config file or UI
const PUREF_EXECUTABLE_PATH = 'C:/Program Files/PureRef/PureRef.exe'; // IMPORTANT: User must set this
const PUREF_SCENE_PATH = 'C:/Users/Willp/Documents/Test/MyScene.pur'; // IMPORTANT: User must set this
const EXPORT_DIR = path.join(__dirname, 'exported');
const EXPORT_FILE_PATH = path.join(EXPORT_DIR, 'board.png');
const PORT = 12345;

// --- Setup ---
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR);
}

const app = express();
app.use('/static', express.static(EXPORT_DIR));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- WebSocket Logic ---
wss.on('connection', (ws) => {
  console.log('[WSS] Client connected.');
  ws.on('close', () => {
    console.log('[WSS] Client disconnected.');
  });
  // Send a welcome message or initial state if needed
  ws.send(JSON.stringify({ type: 'status', message: 'Connected to PureRef Connector' }));
});

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// --- PureRef Interaction ---
function exportPureRefScene() {
  console.log('[PureRef] Exporting scene...');
  // Command to export the scene as an image
  const command = `"${PUREF_EXECUTABLE_PATH}" -c "load;${PUREF_SCENE_PATH}" -c "exportScene;${EXPORT_FILE_PATH}" -c "exit"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`[PureRef Error] exec error: ${error}`);
      return;
    }
    console.log(`[PureRef] Scene exported successfully to ${EXPORT_FILE_PATH}`);
    
    // Notify frontend that a new image is ready
    broadcast({ type: 'refresh' });
  });
}

// --- File Watching ---
console.log(`[Watcher] Watching for changes in: ${PUREF_SCENE_PATH}`);
const watcher = chokidar.watch(PUREF_SCENE_PATH, {
  persistent: true,
  ignoreInitial: true, // Don't trigger on initial setup
});

watcher.on('change', (path) => {
  console.log(`[Watcher] File ${path} has been changed.`);
  // Wait a moment to ensure file writing is complete before exporting
  setTimeout(exportPureRefScene, 1000); 
});

watcher.on('error', (error) => {
  console.error(`[Watcher] Error: ${error}`);
});


// --- Start Server ---
server.listen(PORT, () => {
  console.log(`[Server] PureRef Connector running on http://localhost:${PORT}`);
  console.log(`[Server] Serving exported image from: http://localhost:${PORT}/static/board.png`);
});
