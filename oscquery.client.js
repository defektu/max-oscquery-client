/**
 * Max/MSP OSCQuery Client
 * A node.script-based external object for connecting to OSCQuery servers
 *
 * Usage in Max:
 *   [node.script oscquery.client.js]
 *   |
 *   [route param change state disconnect]
 *   |
 *   [param( [outlet 0]  // Parameter list
 *   [change( [outlet 1]  // Parameter changes
 *   [state( [outlet 2]  // Connection state
 *   [disconnect( [outlet 3]  // Disconnect bang
 *   [sent( [outlet 4]  // Parameter sent
 *   [others( [outlet 5]  // Other messages
 *
 * Note: node.script has only 1 output edge. Data is sent with routing tags:
 *   - "param" for parameter list (outlet 0)
 *   - "change" for parameter changes (outlet 1)
 *   - "state" for connection state (outlet 2)
 *   - "disconnect" for disconnect bang (outlet 3)
 *   - "sent" for parameter sent (outlet 4)
 *   - "others" for other messages (outlet 5)
 *
 * Inlets: 1 (all messages)
 * Outlets: 1 (with routing tags - use [route] to split)
 */

const maxAPI = require("max-api");
const ParameterManager = require("./lib/core/ParameterManager");
const ConnectionManager = require("./lib/core/ConnectionManager");
const ReconnectionManager = require("./lib/core/ReconnectionManager");

/**
 * Send data to Max outlet with routing tag
 * node.script has only 1 output edge
 * We send data with routing tags so Max can route to different destinations
 * Format: [tag, ...data] where tag identifies the outlet type
 */
function outletTo(index, ...args) {
  let tag;
  switch (index) {
    case 0:
      tag = "param"; // Parameter list
      break;
    case 1:
      tag = "change"; // Parameter changes
      break;
    case 2:
      tag = "state"; // Connection state
      break;
    case 3:
      tag = "disconnect"; // Disconnect bang
      maxAPI.outlet("disconnect", "bang");
      return;
    case 4:
      tag = "sent"; // Sent parameter
      break;
    default:
      tag = "unknown";
  }
  // Send with routing tag as first argument
  maxAPI.outlet(tag, ...args);
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  maxAPI.post({ args: args });

  const updateModeArg = args.find((arg) => arg.startsWith("update_mode="));
  const updateMode = updateModeArg
    ? updateModeArg.split("=")[1] === "true"
    : false;

  const urlArg = args.find((arg) => arg.startsWith("url="));
  const baseUrl = urlArg ? urlArg.split("=")[1] : "http://localhost:5678";

  const autoconnectArg = args.find((arg) => arg.startsWith("autoconnect="));
  const autoconnect = autoconnectArg
    ? autoconnectArg.split("=")[1] === "true"
    : false;

  const autoreconnectArg = args.find((arg) => arg.startsWith("autoreconnect="));
  const autoreconnect = autoreconnectArg
    ? autoreconnectArg.split("=")[1] === "true"
    : true;

  return {
    updateMode,
    baseUrl,
    autoconnect,
    autoreconnect,
  };
}

// Initialize state object
const state = {
  baseUrl: null,
  hostInfo: null,
  namespace: null,
  connected: false,
  autoconnect: false,
  autoreconnect: true,
  reconnectInterval: 500,
  isReconnecting: false,
  manualDisconnect: false,
  timeout: 5000,
  timeoutTimer: null,
  paramsDict: null,
  updateMode: true,
};

// Initialize managers
const parameterManager = new ParameterManager();

// Parse command line arguments
const { updateMode, baseUrl, autoconnect } = parseArgs();
state.updateMode = updateMode;
state.baseUrl = baseUrl;
state.autoconnect = autoconnect;

maxAPI.post("node version: ", process.version);
maxAPI.post(
  "AUTOINIT: baseUrl: ",
  baseUrl,
  "updateMode: ",
  updateMode,
  "autoconnect: ",
  autoconnect
);

// Initialize connection manager (reconnectionManager will be set up after)
let reconnectionManager = null;

const connectionManager = new ConnectionManager(state, parameterManager, {
  onConnected: () => {
    state.manualDisconnect = false;
    state.isReconnecting = false;
    state.connected = true;
    if (reconnectionManager) {
      reconnectionManager.clear();
    }
    outletTo(2, "connected");
  },
  onDisconnected: (isDisconnectBang) => {
    state.connected = false;
    outletTo(2, "disconnected");
    if (isDisconnectBang) {
      outletTo(3);
    }
    // Schedule reconnection if enabled
    if (reconnectionManager) {
      reconnectionManager.schedule();
    }
  },
  onParameterChange: (path, value) => {
    // Output parameter change
    if (Array.isArray(value)) {
      outletTo(1, path, ...value);
    } else {
      outletTo(1, path, value);
    }
    // If update mode is on, also output the full paramsDict
    if (state.updateMode && state.paramsDict) {
      outletTo(0, state.paramsDict);
    }
  },
  onParameterList: (paramsDict) => {
    outletTo(0, paramsDict);
  },
  onParameterSent: (sentObject) => {
    outletTo(4, sentObject);
  },
  onError: (error) => {
    maxAPI.post(
      "Connection error:",
      error && error.message ? error.message : String(error)
    );
    console.error(
      "Connection error:",
      error && error.message ? error.message : String(error)
    );
  },
  onLog: (message, ...args) => {
    maxAPI.post(message, ...args);
  },
});

// Initialize reconnection manager
reconnectionManager = new ReconnectionManager(state, connectionManager, {
  onLog: (message, ...args) => {
    maxAPI.post(message, ...args);
  },
});

// Initialize Max API handlers
maxAPI.addHandler("connect", (url) => {
  state.manualDisconnect = false;
  state.baseUrl = url || state.baseUrl;
  reconnectionManager.clear();
  connectionManager.connect(state.baseUrl).catch((error) => {
    maxAPI.post("Connect failed:", error.message);
    reconnectionManager.schedule();
  });
});

maxAPI.addHandler("disconnect", () => {
  state.manualDisconnect = true;
  state.connected = false;
  reconnectionManager.stop();
  connectionManager.disconnect(false);
});

maxAPI.addHandler("autoconnect", (value) => {
  state.autoconnect = value ? true : false;
  maxAPI.post("autoconnect: ", state.autoconnect);
});

maxAPI.addHandler("autoreconnect", (value) => {
  state.autoreconnect = value ? true : false;
  maxAPI.post("autoreconnect: ", state.autoreconnect);
  if (!state.autoreconnect) {
    reconnectionManager.stop();
  } else if (!state.connected && !state.manualDisconnect && state.baseUrl) {
    reconnectionManager.schedule();
  }
});

maxAPI.addHandler("reconnect_interval", (ms) => {
  reconnectionManager.setInterval(ms);
  maxAPI.post("reconnect_interval: ", state.reconnectInterval, "ms");
});

maxAPI.addHandler("timeout", (ms) => {
  state.timeout = parseInt(ms, 10) || 5000;
});

maxAPI.addHandler("refresh_params", () => {
  maxAPI.post("Refreshing parameter list");
  connectionManager.refreshList();
});

maxAPI.addHandler("update_mode", (value) => {
  if (!state.paramsDict) {
    maxAPI.post("paramsDict not initialized");
    return;
  }
  state.updateMode = value === "true" || value === true;

  if (state.updateMode && state.paramsDict) {
    // Update mode was turned on, output the current state
    outletTo(0, state.paramsDict);
    maxAPI.post("Update mode enabled, outputting current state");
  } else {
    maxAPI.post("Update mode disabled");
  }
});

maxAPI.addHandler("ping", () => {
  maxAPI.post("Received ping, sending pong");
  outletTo(5, "pong"); // Sends: others pong
});

maxAPI.addHandler("send", (path, ...args) => {
  if (path === undefined || args.length === 0) {
    maxAPI.post("Path and value are required");
    return;
  }

  try {
    connectionManager.setParameter(path, ...args);
  } catch (error) {
    // Error already logged in ConnectionManager
  }
});

// Initialize
maxAPI.post("OSCQuery Client initialized");
if (state.autoconnect && state.baseUrl) {
  connectionManager.connect(state.baseUrl).catch((error) => {
    maxAPI.post("AutoConnect failed:", error.message);
    if (state.autoreconnect) {
      reconnectionManager.schedule();
    }
  });
}
outletTo(2, "disconnected"); // Initial connection state: disconnected

// Note: Attributes are handled via messages. To use autoconnect:
// 1. Set @autoconnect 1 and @url <url> in Max object attributes
// 2. Or send "autoconnect 1" and "url <url>" messages
// 3. Then send "bang" to trigger autoconnect
