# Max/MSP OSCQuery Client

A node.script-based external object for connecting to OSCQuery servers in Max/MSP.

## Description

This package provides a Max/MSP client for OSCQuery servers, allowing you to discover, connect to, and interact with OSCQuery-compatible applications. It uses WebSocket connections for real-time parameter updates and HTTP for initial discovery.

## Requirements

- Max/MSP with node.script support
- Node.js >= 12.0.0
- An OSCQuery server to connect to

## Installation

#### 

1. Clone or download this repository
2. Open up ```oscqueryexample.maxpat```

## Usage in Max/MSP

### Basic Setup

1. Create a `[node.script oscquery.client.js]` object in your Max patch
2. Use `[route]` to split the output by routing tags:
   ```
	[node.script oscquery.client.js]
	|
	[route param change state disconnect sent others]
	|
	+--> [param(       ]  outlet 0 — Parameter list
	+--> [change(      ]  outlet 1 — Parameter changes
	+--> [state(       ]  outlet 2 — Connection state
	+--> [disconnect(  ]  outlet 3 — Disconnect bang
	+--> [sent(        ]  outlet 4 — Parameter sent
	+--> [others(      ]  outlet 5 — Other messages
   ```

### Routing Tags

The node.script object has only 1 output edge. Data is sent with routing tags:
- `"param"` - Parameter list (outlet 0)
- `"change"` - Parameter changes (outlet 1)
- `"state"` - Connection state (outlet 2)
- `"disconnect"` - Disconnect bang (outlet 3)
- `"sent"` - Parameter sent confirmation (outlet 4)
- `"others"` - Other messages (outlet 5)

## Messages

### Connection

- `connect <url>` - Connect to an OSCQuery server
  - Example: `connect http://localhost:5678`
  
- `disconnect` - Disconnect from the server

- `autoconnect <0|1>` - Enable/disable auto-connect on initialization

- `timeout <ms>` - Set connection timeout in milliseconds (default: 5000)

### Parameters

- `send <path> <value1> [value2] ...` - Send a parameter value to the server
  - Example: `send /oscillator/frequency 440.0`
  - Example: `send /mixer/volume 0.5 0.7`

- `refresh_params` - Refresh the parameter list from the server

- `update_mode <0|1>` - Enable/disable update mode (outputs full paramsDict on each change)

### Utility

- `ping` - Send a ping message (responds with "pong")

## Attributes

You can set these attributes in the Max object inspector or via messages:

- `@url <url>` - Default server URL (default: `http://localhost:5678`)
- `@autoconnect <true|false>` - Auto-connect on initialization (default: 0)
- `@update_mode <true|false>` - Update mode (default: 0)

## Dependencies

- `ws` (^8.18.3) - WebSocket library for Node.js

## Notes

- The client uses the `ws` package for WebSocket support (native WebSocket is disabled)
- WebSocket connections are established automatically if the server supports the LISTEN extension
- Parameter values are validated against type information from the server before sending
- All parameter changes are automatically listened to via WebSocket when connected

