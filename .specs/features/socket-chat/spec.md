# Socket Chat Specification

## Problem Statement

Kodama saves and runs HTTP requests, but users need a repeatable way to inspect live WebSocket and Socket.IO conversations. The demo should let users judge the interaction without setting up another service.

## Goals

- Save and reopen WebSocket and Socket.IO connections in collections.
- Connect, send, and inspect events from both protocols in a live log.
- Try both protocols against one local demo chat.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Binary message composer | The first release focuses on readable chat and JSON events. |
| Socket scripts and permanent event history | HTTP scripts assume one response; socket events need a separate model. |
| Automatic reconnect | Explicit reconnect keeps connection state clear. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Connection lifetime | One connection per open tab; close with tab | Matches Kodama tab sessions and limits background activity | n |
| Message format | JSON or plain text | Covers common readable socket use cases | n |
| Socket.IO auth | JSON handshake auth plus existing headers and Basic/Bearer | Covers common Socket.IO server configuration | n |

**Open questions:** none; the defaults above define the first release.

## User Stories

### P1: Save and use a socket request

**User Story**: As an API developer, I want a saved connection and message composer so I can repeat a socket exchange.

**Acceptance Criteria**:

1. WHEN a user creates a WebSocket or Socket.IO request THEN Kodama SHALL save its protocol, URL, connection settings, and message payload in the collection.
2. WHEN a user opens a saved socket request THEN Kodama SHALL show controls to connect, disconnect, and send a message.
3. WHEN a socket receives an event THEN Kodama SHALL append its timestamp, event name, and payload to the live log.
4. WHEN a user closes a connected socket tab THEN Kodama SHALL disconnect that tab's connection.

**Independent Test**: Create and save each protocol, connect, send, and reopen the request.

### P1: Try both protocols locally

**User Story**: As a user evaluating Kodama, I want a ready chat example so I can see how socket testing feels.

**Acceptance Criteria**:

1. WHEN a WebSocket client sends valid chat JSON THEN the demo SHALL deliver a message event to connected Socket.IO clients.
2. WHEN a Socket.IO client emits `chat:send` with valid chat JSON THEN the demo SHALL deliver a message frame to connected WebSocket clients.
3. IF a chat message is empty or longer than 500 characters THEN the demo SHALL return a readable error to its sender.
4. WHEN a user imports the chat collection THEN Kodama SHALL show one configured request for each protocol.

**Independent Test**: Import the collection and exchange a message between the two tabs.

## Edge Cases

- IF the URL protocol is incompatible with the selected socket type THEN Kodama SHALL show a connection error without opening a connection.
- IF a JSON message is malformed THEN Kodama SHALL show an error without sending it.
- IF a socket disconnects THEN Kodama SHALL show Disconnected and allow another connection attempt.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| SOCK-01 | Save and use a socket request | Native transport | Verified |
| SOCK-02 | Save and use a socket request | UI | Verified |
| SOCK-03 | Try both protocols locally | Demo | Verified |

**Coverage:** 3 total, 3 mapped to tasks, 0 unmapped.

## Success Criteria

- [x] Both saved protocols connect and exchange messages with the demo.
- [x] Invalid JSON and bad connections surface readable errors.
- [x] Existing HTTP requests and workspaces still load and run.
