// Wire protocol shared between the bridge server and any client (human UI or agent).
// All messages are JSON over a single WebSocket connection.

export type MouseButton = "left" | "middle" | "right";

export type ModifierKey = "Alt" | "Control" | "Meta" | "Shift";

export interface ClickAction {
  type: "click";
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  modifiers?: ModifierKey[];
}

export interface MouseMoveAction {
  type: "mousemove";
  x: number;
  y: number;
  buttons?: MouseButton[];
  modifiers?: ModifierKey[];
}

export interface TypeAction {
  type: "type";
  text: string;
}

export interface KeyAction {
  type: "key";
  key: string;
  code?: string;
  modifiers?: ModifierKey[];
  // "down" + "up" lets a client hold a key; "press" sends both in sequence.
  phase: "down" | "up" | "press";
}

export interface ScrollAction {
  type: "scroll";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

export interface NavigateAction {
  type: "navigate";
  url: string;
}

export interface ReloadAction {
  type: "reload";
  ignoreCache?: boolean;
}

export interface BackAction {
  type: "back";
}

export interface ForwardAction {
  type: "forward";
}

export interface SwitchTabAction {
  type: "switchTab";
  tabId: string;
}

export interface NewTabAction {
  type: "newTab";
  url?: string;
}

export interface CloseTabAction {
  type: "closeTab";
  tabId: string;
}

// Bring the bridge's currently-attached tab back to foreground in the user's
// real Chrome window — used when they've switched away from it manually.
export interface RefocusAction {
  type: "refocus";
}

// Force-reload the bridge's currently-attached tab. Used to wake a tab that
// Chrome's Memory Saver has discarded (no renderer running).
export interface ReviveTabAction {
  type: "reviveTab";
}

// User's pointer left the bridge's screen frame. Lets the server arm the
// hovered-link auto-clear timer without waiting for further mousemoves —
// otherwise a URL hovered just before the cursor left would sit visible
// indefinitely.
export interface MouseLeaveAction {
  type: "mouseleave";
}

export type ClientAction =
  | ClickAction
  | MouseMoveAction
  | TypeAction
  | KeyAction
  | ScrollAction
  | NavigateAction
  | ReloadAction
  | BackAction
  | ForwardAction
  | SwitchTabAction
  | NewTabAction
  | CloseTabAction
  | RefocusAction
  | ReviveTabAction
  | MouseLeaveAction;

export interface ClientActionMessage {
  type: "action";
  // Optional id lets the client correlate ack/error responses.
  id?: string;
  action: ClientAction;
}

export interface ClientHelloMessage {
  type: "hello";
  // Identifies the client for logging/replay; agents should use a stable id.
  client: string;
  role: "human" | "agent";
}

export type ClientMessage = ClientHelloMessage | ClientActionMessage;

export interface ScreenshotMessage {
  type: "screenshot";
  // Base64-encoded PNG/JPEG.
  data: string;
  format: "png" | "jpeg";
  width: number;
  height: number;
  // Device pixel ratio so clients can map between viewport css px and image px.
  deviceScaleFactor: number;
  // Monotonic frame number for replay alignment.
  frame: number;
  capturedAt: number;
}

export interface PageStateMessage {
  type: "page";
  url: string;
  title: string;
  loading: boolean;
}

export interface AckMessage {
  type: "ack";
  id?: string;
}

export interface ErrorMessage {
  type: "error";
  id?: string;
  message: string;
}

export interface ReadyMessage {
  type: "ready";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  url: string;
  title: string;
  // Display string for the CDP endpoint (e.g. "127.0.0.1:9222"), shown in the
  // status bar so users running multiple bridges can tell instances apart.
  cdpEndpoint?: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface TabsMessage {
  type: "tabs";
  tabs: TabInfo[];
}

// Whether the bridge's currently-attached tab is foreground in the user's real
// Chrome. Driven by Page.screencastVisibilityChanged. When false, the screen
// frame is stale (Chrome stops compositing backgrounded tabs); the UI greys
// the active tab title and routes clicks-on-frame to a refocus action.
export interface VisibilityMessage {
  type: "visibility";
  visible: boolean;
}

// Surfaced when the bridge has switched to a tab and no screencast frame
// arrives within a few seconds — almost always means Chrome's Memory Saver
// has discarded the renderer. The UI should prompt the user before reloading
// (which loses any in-page state).
export interface InactiveTabMessage {
  type: "inactive";
  tabId: string;
}

// URL of the link currently hovered in the remote page (or null when nothing
// is hovered). Detected server-side via Runtime.evaluate using the bridge's
// own mousemove coordinates, throttled so it doesn't flood the CDP channel.
export interface HoverMessage {
  type: "hover";
  href: string | null;
}

export type ServerMessage =
  | ReadyMessage
  | ScreenshotMessage
  | PageStateMessage
  | TabsMessage
  | VisibilityMessage
  | InactiveTabMessage
  | HoverMessage
  | AckMessage
  | ErrorMessage;
