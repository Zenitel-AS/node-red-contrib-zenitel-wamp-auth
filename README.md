# Zenitel WAMP Node-RED Nodes

Custom Node-RED nodes inside `zenitel-wamp-authLWE.js` expose Zenitel intercom functionality over WAMP. They are grouped into **event** (subscriptions), **action** (commands) and **request** (state/query) nodes, all sharing the same connection and payload conventions.

## Connection & Authentication

- Use the `wamp-client` configuration node to define target **IP**, **port**, **authId** and **password**. The node always connects to `wss://<ip>:<port>` on realm `zenitel`.
- TLS 1.2-1.3 is enforced and `NODE_TLS_REJECT_UNAUTHORIZED` is set to `0`, so self-signed Zenitel certificates are accepted.
- Ticket authentication is implemented by `GetToken()`, which performs an HTTPS `POST /api/auth/login` call using HTTP Basic credentials and injects the returned `access_token` in the WAMP `onchallenge` handler.
- Connections are pooled by `wampClientPool`, so multiple nodes reuse the same Autobahn session; closing a configuration node tears down its pooled session.

## Payload & Error Conventions

- Every action/request node calls `ensurePayloadObject` so `msg.payload` is coerced to an object (or an empty object). Arrays can be supplied where explicitly stated (for example, multiple call-forward rules).
- `wrapWampCallPayload` mirrors object payloads into both `args[0]` and `kwargs` before executing `session.call`, which keeps Zenitel procedures that expect positional or keyword arguments satisfied.
- Many nodes accept several aliases for the same field (`from_dirno`, `fromdirno`, `audio_msg_dirno`, etc.). `assignConfigValue` copies configured defaults into missing payload fields, `syncAliases` keeps aliases in sync, and `findMissingAliases` reports missing mandatory groups.
- When required data is missing or invalid, `reportMissing` sets the node status to red, writes an error message into `msg.error`, and forwards the message for downstream diagnostics.
- Successful WAMP responses overwrite `msg.payload` with the returned object/array. Rejections keep the original payload but also set `msg.error`.

## Event Nodes (Subscriptions)

| Node | Topic | Purpose | Key filters |
|------|-------|---------|-------------|
| `Zenitel WAMP In` | `config.topic` | Generic subscriber/registration node | None (user supplies topic) |
| `Zenitel GPI Event` | `com.zenitel.device.gpi` | Emits GPI state changes | `dirno`, `GPinput` (matching `gpiX`/`gpioX`), `GPstate` |
| `Zenitel GPO Event` | `com.zenitel.device.gpo` | Emits GPO operations | `dirno`, `GPoutput`, `GPstate` |
| `Zenitel Door Open` | `com.zenitel.system.open_door` | Door open events from any device | `door_dirno`, `from_dirno` |
| `Zenitel Call State` | `com.zenitel.call` | Any call setup/connected/ended state | `fromdirno`, `todirno`, `callstate`, `reason` |
| `Zenitel Device State` | `com.zenitel.system.device_account` | Device registration/online state | `dirno`, exact `state` (case-insensitive) |
| `Zenitel Event Trigger` | `com.zenitel.system.event_trigger` | ZCP-defined triggers | `dirno` (from), `eventno` (to) |
| `Zenitel Extended State` | `com.zenitel.system.device.extended_status` | Hardware test or health status | `dirno`, `testtype`, `testresult` |

### Notes per event node

- **Zenitel WAMP In**: exposes a plain `subscribe` to any topic you provide. Every message arrives as `{ topic, payload: { args, kwargs } }`.
- **Zenitel GPI Event**: normalises filter values so `gpi1` equals `gpio1`. Matches succeed when incoming values `include` the configured strings, so partial matches are allowed (`1001` matches filter `100`). Sends raw `args` & `kwargs`.
- **Zenitel GPO Event**: filters on `dirno`, `id`, and `operation`. The incoming payload is expected at `payload.args[0]`.
- **Zenitel Door Open**: builds a `payload.data` object from either `kwargs` or `args[0]` and compares `door_dirno`/`from_dirno`. Useful for seeing which station opened which door.
- **Zenitel Call State**: extracts `fromdirno`, `todirno`, `callstate`, and `reason` from any of the typical Zenitel field names (`from_dirno`, `call_state`, `cause`, etc.). Empty filters mean "match everything".
- **Zenitel Device State**: recognises `dirno`, `dir_no`, or `device_id` plus `state/status/device_state`. Case-insensitive equality is used for the state filter.
- **Zenitel Event Trigger**: expects Zenitel's event payload layout (`from_dirno`, `to_dirno`). Filter strings use `String.includes`, so you can subscribe to entire ranges/prefixes.
- **Zenitel Extended State**: surfaces self-test or monitoring events. `payload.data` holds harmonised fields (`dirno`, `status_type`, `current_status`), making downstream logic easier.

Most event nodes keep their node status indicator green while the pooled connection is open and switch to red when the connection closes.

## Action Nodes (Commands)

| Node | Procedure | Purpose | Required payload |
|------|-----------|---------|------------------|
| `Zenitel WAMP Out` | `config.procedure` | Generic caller for any Zenitel procedure | Whatever the target expects |
| `Zenitel Call Setup` | `com.zenitel.calls.post` | Start or manipulate a call | `from_dirno`, `to_dirno`; optional `priority` (defaults `40`), `action` (defaults `setup`), `verbose` |
| `Zenitel Play Audio Message` | `com.zenitel.calls.post` | Start message playback | `audio_msg_dirno`/`from_dirno`, `to_dirno`; optional `priority`, `action` |
| `Zenitel Door Opener` | `com.zenitel.calls.call.open_door.post` | Trigger remote door relay for an active call | `from_dirno` (station that owns the call) |
| `Zenitel GPO Trigger` | `com.zenitel.devices.device.gpos.gpo.post` | Operate a specific GPO | `dirno`, `id` (GPO), `operation` (`set`, `clear`, `slow_blink`, `fast_blink`, `set_timed`); `time` required for `set_timed` |
| `Zenitel Key Press` | `com.zenitel.devices.device.key.post` | Simulate a button edge | `dirno`, `id`; optional `edge`/`action` (`tap` default) |
| `Zenitel Setup Call Forwarding` | `com.zenitel.call_forwarding.post` | Apply one or more call-forward rules | Array (or single object) with `dirno`, `fwd_type`, `fwd_to`, `enabled` |
| `Zenitel Delete Call Forwarding` | `com.zenitel.call_forwarding.delete` | Remove forwarding rules | `dirno`, `fwd_type` (`unconditional`, `on_busy`, `on_timeout`, or `all`) |
| `Zenitel Button Test` | `com.zenitel.system.devices.test.button.post` | Run the button hardware test | `dirno` |
| `Zenitel Tone Test` | `com.zenitel.system.devices.test.tone.post` | Run the tone generator test | `dirno` |
| `Zenitel Call End` | `com.zenitel.calls.delete` | Clear an active call by `dirno` | `dirno` of the call/device |
| `Zenitel Audio Message End` | `com.zenitel.calls.delete` | Stop an ongoing audio message | `dirno` of the audio message call leg |

### Notes per action node

- **Generic WAMP Out**: perfect for advanced or not-yet-modelled API calls. Supply the full payload object or array; it will be wrapped automatically.
- **Call Setup / Play Audio Message**: both normalise aliases (`fromdirno`/`from_dirno`, `todirno`/`to_dirno`) and coerce values to strings. Priorities default to `40`, and the action defaults to `setup` unless explicitly overridden (e.g., to `pickup`, `answer`, `cancel`).
- **Door Opener**: expects the `from_dirno` that identifies the current call (typically the answering station). Additional payload keys are preserved and sent to the API.
- **GPO Trigger**: `operation` strings are de-duplicated (e.g., `slowblink`, `slow blink` -> `slow_blink`). Invalid operations or missing `time` for `set_timed` raise a validation error via `reportMissing`.
- **Key Press**: alias handling allows `edge` or `action`. Accepted edges are whatever the Zenitel API supports (`tap`, `press`, `release`, etc.); unspecified values default to `tap`.
- **Setup Call Forwarding**: accepts either a single object in `msg.payload` or an array. Merges config/payload aliases for `dirno`, the forward target (`fwddirno`/`forward_dirno`/`to_dirno`/`todirno`/`fwd_to`), and the rule (`rule`/`fwd_type`). Boolean strings such as `"enable"` / `"disable"` become proper booleans, and errors call out the rule index with missing fields.
- **Delete Call Forwarding**: requires a `dirno` plus `fwd_type`; setting `fwd_type` to `all` removes every rule for that station. The node accepts `fwd_type` or legacy `rule` in both config and payload, normalising to `fwd_type` before the call.
- **Hardware tests & call termination nodes**: small wrappers that only require `dirno`. They are ideal for wiring directly to inject nodes or dashboards.

## Request Nodes (Queries)

| Node | Procedure | Description | Filters |
|------|-----------|-------------|---------|
| `Zenitel Device Account Request` | `com.zenitel.system.device_accounts` | Lists device accounts with optional state filtering | `state` (omit or `"all"`/`"*"` to fetch everything) |
| `Zenitel Audio Message Request` | `com.zenitel.system.audio_messages` | Lists available audio messages | None |
| `Zenitel Groups Request` | `com.zenitel.groups` | Retrieves group definitions | `dirno`/`groupdirno`, `verbose` |
| `Zenitel Directory Request` | `com.zenitel.directory` | Pulls directory entries | `dirno` (optional) |
| `Zenitel Call Forwarding Request` | `com.zenitel.call_forwarding` | Reads forwarding rules | `dirno`, `fwd_type` (omit/`all`/`*` to fetch all types) |
| `Zenitel Current Calls` | `com.zenitel.calls` | Lists calls matching criteria | `from_dirno`, `to_dirno`, `state`, `verbose` |
| `Zenitel Current Call Queues` | `com.zenitel.call_queues` | Lists queue members | `queue_dirno` |
| `Zenitel GPO Request` | `com.zenitel.devices.device.gpos` | Reads GPO state for a device | `dirno`/`device_id` (required), `id`/`gpo_id` (omit/`all`/`*` for every output) |
| `Zenitel GPI Request` | `com.zenitel.devices.device.gpis` | Reads GPI state for a device | `dirno`/`device_id` (required), `id`/`gpi_id` (omit/`all`/`*` for every input) |
| `Zenitel WAMP Request` | `config.procedure` | Generic query node mirroring `Zenitel WAMP Out` but intended for idempotent reads | Whatever the target expects |

### Notes per request node

- All request nodes call the associated procedure and forward the returned array/object in `msg.payload`.
- **Device Account Request**: normalises `state` to lowercase; `"all"` or `"*"` removes the filter entirely.
- **Audio Message Request**: wraps an empty payload, which Zenitel interprets as "list everything".
- **Groups Request**: supports `dirno`, `groupdirno`, or a configured default, plus a `verbose` flag that understands `"true"/"false"`, `"yes"/"no"`, and numeric strings.
- **Directory Request**: accepts a single `dirno` filter; leave blank for all records.
- **Call Forwarding Request**: optional `dirno`/`fwd_type` filters. Setting `fwd_type` to `"all"` behaves the same as omitting it.
- **Current Calls**: supports `from_dirno`, `to_dirno`, `state`, `verbose`. Blank or `"*"` removes the field from the query.
- **Current Call Queues**: optional `queue_dirno`; blank values fetch all queues.
- **GPO Request**: requires a device `dirno`/`device_id` and optionally narrows results to a specific output via `id`/`gpo_id`; `"*"`, `"all"`, or blank pulls every GPO for the device.
- **GPI Request**: same pattern as GPO Request but targets inputs; `"*"`, `"all"`, or blank returns the complete list.
- **Zenitel WAMP Request**: the request counterpart to `Zenitel WAMP Out`, handy for ad-hoc diagnostics or new API endpoints.

## Dynamic Subscribe Helper

`wamp subs` (`WampClientSubscribe`) is a utility node that subscribes to a topic provided at runtime in `msg.topic`. It is useful for dashboard-driven subscriptions or for temporarily tapping into seldom-used topics without wiring dedicated nodes.

## Example Flows

```text
[Inject] --(msg.payload = {from_dirno:"1001", to_dirno:"1002"})--> [Zenitel Call Setup] --calls--> [Debug]
[Zenitel Call State] --filters to_dirno=1002--> [Function] (update UI)
[Inject msg.payload={dirno:"1002", id:"gpo1", operation:"set_timed", time:5}] --> [Zenitel GPO Trigger]
```

## Troubleshooting Tips

- Watch the node status dot: green means the pooled Autobahn session is live, red indicates the connection (or authentication) dropped.
- When a field is missing, the node adds a human-readable string to `msg.error`. Consider wiring Debug nodes to both the `msg.payload` and `msg.error` paths.
- Because TLS validation is disabled, always restrict Node-RED access; otherwise credentials could be intercepted by a man-in-the-middle.
- Reuse `Zenitel WAMP Out` / `Zenitel WAMP Request` before adding new specialised nodes - the helper functions already perform aliasing and validation, so you get consistent behaviour.


