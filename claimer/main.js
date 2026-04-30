/**
 * Captcha Detection and Hardware Click Bridge
 * 
 * This extension detects Cloudflare Turnstile captcha and sends coordinates
 * to a Python backend that performs hardware-level clicks via xdotool.
 *
 * The key challenge: JavaScript click events are detected by Cloudflare as synthetic.
 * Solution: Use xdotool via Python to generate X11-level input events that appear
 * as hardware input to applications running under XRDP.
 *
 * SESSION MANAGEMENT (matches Python Flask backend exactly):
 *   - Fresh conversation per call (default)
 *   - reuse_session: true  → reuse the last conversation
 *   - session_id: "name"   → named persistent thread
 *   - conversation_id: "x" → explicit thread (highest priority)
 *
 * IMPORTANT: Each new API call WITHOUT explicit session parameters creates a 
 * FRESH conversation by calling POST /api/conversations to get a new conversation ID.
 */

(function() {
    'use strict';

    // ================================
    // CONFIGURATION
    // ================================
    const CONFIG = {
        // Local WebSocket server (Python backend for hardware clicks)
        HARDWARE_CLICK_SERVER: "ws://127.0.0.1:8765",

        // Backend WSS URL (your existing server)
        BACKEND_WSS_URL: "wss://ai-wss-685eced2e7b5.herokuapp.com/ws",

        // Copilot API endpoints
        COPILOT_CONVERSATIONS_URL: "https://copilot.microsoft.com/c/api/conversations",
        COPILOT_CHAT_URL: "wss://copilot.microsoft.com/c/api/chat?api-version=2",

        // Captcha detection settings
        CAPTCHA_CHECK_INTERVAL: 1000,  // Check every 1 second
        CAPTCHA_SELECTORS: [
            '#cf-turnstile',
            '[id^="cf-chl-widget"]',
            'iframe[src*="challenges.cloudflare.com"]',
            'iframe[src*="turnstile"]',
            '.cf-turnstile',
            '#challenge-form',
            'div[class*="turnstile"]',
            'iframe[title*="Widget containing a Cloudflare security challenge"]'
        ],

        // Click target within captcha iframe
        TURNSTILE_CLICK_SELECTORS: [
            'input[type="checkbox"]',
            '.ctp-checkbox-label',
            'label',
            '[role="checkbox"]',
            '.mark',
            '.ctp-checkbox'
        ],

        // Timeouts
        API_TIMEOUT: 10000,              // 10s timeout for API calls
        WEBSOCKET_TIMEOUT: 60000,        // 60s timeout for chat responses
        RECONNECT_DELAY: 3000,           // 3s between reconnect attempts
        MAX_RECONNECT_ATTEMPTS: 10
    };

    // ================================
    // CSS STYLES
    // ================================
    const style = document.createElement('style');
    style.innerHTML = `
        .ai-tap-ripple {
            position: absolute; width: 40px; height: 40px; background: rgba(255, 0, 0, 0.7);
            border-radius: 50%; pointer-events: none; transform: translate(-50%, -50%);
            animation: ripple-out 0.8s ease-out forwards; z-index: 9999999;
        }
        @keyframes ripple-out {
            from { transform: translate(-50%, -50%) scale(0); opacity: 1; }
            to { transform: translate(-50%, -50%) scale(3); opacity: 0; }
        }
        .captcha-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(255, 165, 0, 0.3); z-index: 2147483646;
            pointer-events: none; display: flex; align-items: center; justify-content: center;
        }
        .captcha-overlay::after {
            content: '🤖 CAPTCHA DETECTED - Requesting hardware click...';
            background: rgba(0,0,0,0.8); color: white; padding: 20px 40px;
            border-radius: 10px; font-size: 18px; font-family: system-ui;
        }
        .bridge-status {
            position: fixed; bottom: 10px; right: 10px; 
            background: rgba(0,0,0,0.8); color: #0f0; 
            padding: 8px 12px; border-radius: 5px; 
            font-family: monospace; font-size: 12px; z-index: 9999999;
        }
    `;
    document.head.appendChild(style);

    // ================================
    // UTILITIES
    // ================================
    window.showTap = function(x, y) {
        const ripple = document.createElement('div');
        ripple.className = 'ai-tap-ripple';
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';
        document.body.appendChild(ripple);
        setTimeout(() => ripple.remove(), 800);
    };

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    // Native setter helper for React inputs
    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;
        
        if (valueSetter) {
            valueSetter.call(element, value);
        } else {
            element.value = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Safe JSON parser that handles the \x1e delimiter
    function safeParse(str) {
        try {
            if (typeof str === 'string' && str.endsWith('\x1e')) {
                str = str.slice(0, -1);
            }
            return JSON.parse(str);
        } catch(e) {
            return null;
        }
    }

    // Generate unique ID
    function generateId() {
        return 'bridge-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    // ================================
    // SESSION MANAGER
    // Mirrors the Python Flask session logic EXACTLY:
    //   sessions["_last"]        → last-used convId (for reuse_session: true)
    //   sessions["<session_id>"] → named persistent thread
    // ================================
    const SessionManager = {
        sessions: {},   // { "_last": "convId", "my-bot": "convId", ... }

        /**
         * Parse session arguments from a backend message payload.
         * Mirrors Python's parse_session_args() exactly.
         *
         * @param {object} data - The raw message from the backend WebSocket.
         * @returns {{ explicitConvId, sessionId, reuseSession }}
         */
        parseArgs(data) {
            if (!data || typeof data !== 'object') {
                return { explicitConvId: null, sessionId: null, reuseSession: false };
            }

            // conversation_id takes highest priority
            const explicitConvId = data.conversation_id || null;

            // session_id must be a non-empty string
            const rawSid = data.session_id;
            const sessionId = (rawSid !== undefined && rawSid !== null && String(rawSid).trim() !== '')
                ? String(rawSid).trim()
                : null;

            // reuse_session is a boolean flag
            const reuseSession = Boolean(data.reuse_session || false);

            return { explicitConvId, sessionId, reuseSession };
        },

        /**
         * Parse session intent from model string (OpenAI-compatible).
         * Mirrors Python's parse_session_from_model_string().
         * 
         *   "copilot"                  -> fresh
         *   "copilot:reuse"            -> reuse last
         *   "copilot:session:<name>"   -> named session
         *
         * @param {string} modelStr - The model name from OpenAI request
         * @returns {{ sessionId, reuseSession }}
         */
        parseFromModelString(modelStr) {
            if (!modelStr || typeof modelStr !== 'string') {
                return { sessionId: null, reuseSession: false };
            }

            const parts = modelStr.split(':');
            
            // copilot:session:<name>
            if (parts.length >= 3 && parts[1] === 'session') {
                const name = parts.slice(2).join(':').trim();
                return { sessionId: name || null, reuseSession: false };
            }
            
            // copilot:reuse
            if (parts.length >= 2 && parts[1] === 'reuse') {
                return { sessionId: null, reuseSession: true };
            }

            return { sessionId: null, reuseSession: false };
        },

        /**
         * Resolve which conversation ID to pass to askCopilot, and which key
         * to store the result under afterward.
         * Mirrors Python's resolve_conv_id() EXACTLY.
         *
         * Priority:
         *   1. explicitConvId  → use as-is, no storage
         *   2. sessionId       → look up named session (or create fresh)
         *   3. reuseSession    → look up "_last" (or create fresh)
         *   4. default         → fresh every call, still stored under "_last"
         *
         * @returns {{ convId: string|null, sessionKey: string|null }}
         */
        resolve(explicitConvId, sessionId, reuseSession) {
            // Priority 1: Explicit conversation_id takes absolute precedence
            if (explicitConvId) {
                console.log(`📌 [SessionManager] Using explicit conversation_id: ${explicitConvId}`);
                return { convId: explicitConvId, sessionKey: null };
            }

            // Priority 2: Named session
            if (sessionId) {
                const existing = this.sessions[sessionId] || null;
                console.log(`📌 [SessionManager] Named session "${sessionId}": ${existing || 'will create fresh'}`);
                return { convId: existing, sessionKey: sessionId };
            }

            // Priority 3: Reuse last session
            if (reuseSession) {
                const existing = this.sessions['_last'] || null;
                console.log(`📌 [SessionManager] Reuse session: ${existing || 'will create fresh'}`);
                return { convId: existing, sessionKey: '_last' };
            }

            // Priority 4: Default - fresh every call, but track under _last
            // This ensures future reuse_session:true has something to reuse
            console.log(`📌 [SessionManager] Default: creating fresh conversation`);
            return { convId: null, sessionKey: '_last' };
        },

        /**
         * Persist the convId that was actually used by the bridge.
         * Called after the bridge reports back usedConvId.
         *
         * @param {string|null} sessionKey
         * @param {string|null} usedConvId
         */
        store(sessionKey, usedConvId) {
            if (sessionKey && usedConvId) {
                this.sessions[sessionKey] = usedConvId;
                console.log(`📌 [SessionManager] Stored: [${sessionKey}] → ${usedConvId}`);
            }
        },

        /**
         * Remove a named session (so the next call starts fresh).
         * @param {string} sessionId
         * @returns {string|null} The previous convId if any
         */
        forget(sessionId) {
            const prev = this.sessions[sessionId] || null;
            delete this.sessions[sessionId];
            console.log(`📌 [SessionManager] Forgot session "${sessionId}" (was: ${prev})`);
            return prev;
        },

        /**
         * Return a snapshot of all tracked sessions.
         */
        list() {
            return Object.assign({}, this.sessions);
        },

        /**
         * Clear all sessions.
         */
        clear() {
            this.sessions = {};
            console.log(`📌 [SessionManager] Cleared all sessions`);
        }
    };

    // ================================
    // HARDWARE CLICK BRIDGE
    // ================================
    class HardwareClickBridge {
        constructor() {
            this.ws = null;
            this.connected = false;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = CONFIG.MAX_RECONNECT_ATTEMPTS;
        }

        connect() {
            return new Promise((resolve, reject) => {
                try {
                    this.ws = new WebSocket(CONFIG.HARDWARE_CLICK_SERVER);

                    this.ws.onopen = () => {
                        console.log("🔌 [HardwareClick] Server connected");
                        this.connected = true;
                        this.reconnectAttempts = 0;
                        resolve();
                    };

                    this.ws.onclose = () => {
                        this.connected = false;
                        console.log("❌ [HardwareClick] Server disconnected");

                        // Auto reconnect
                        if (this.reconnectAttempts < this.maxReconnectAttempts) {
                            this.reconnectAttempts++;
                            setTimeout(() => this.connect(), CONFIG.RECONNECT_DELAY);
                        }
                    };

                    this.ws.onerror = (err) => {
                        console.error("[HardwareClick] Server error:", err);
                        reject(err);
                    };

                    this.ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            console.log("📥 [HardwareClick] Response:", data);
                        } catch (e) {}
                    };

                } catch (e) {
                    reject(e);
                }
            });
        }

        async sendClick(x, y, elementType = 'unknown', iframeOffset = null) {
            if (!this.connected) {
                console.warn("⚠️ [HardwareClick] Server not connected");
                return false;
            }

            const message = {
                action: "captcha_detected",
                x: Math.round(x),
                y: Math.round(y),
                captcha_type: "cloudflare-turnstile",
                element_type: elementType
            };

            if (iframeOffset) {
                message.iframe = iframeOffset;
            }

            console.log("📤 [HardwareClick] Sending click request:", message);

            return new Promise((resolve) => {
                try {
                    this.ws.send(JSON.stringify(message));
                    resolve(true);
                } catch (e) {
                    console.error("[HardwareClick] Failed to send:", e);
                    resolve(false);
                }
            });
        }

        async ping() {
            if (!this.connected) return false;

            return new Promise((resolve) => {
                try {
                    this.ws.send(JSON.stringify({ action: "ping" }));
                    resolve(true);
                } catch (e) {
                    resolve(false);
                }
            });
        }

        disconnect() {
            if (this.ws) {
                this.ws.close();
                this.ws = null;
                this.connected = false;
            }
        }
    }

    // ================================
    // CAPTCHA DETECTOR
    // ================================
    class CaptchaDetector {
        constructor(hardwareBridge) {
            this.hardwareBridge = hardwareBridge;
            this.isProcessing = false;
            this.lastCaptchaTime = 0;
            this.captchaCooldown = 5000; // 5 seconds between attempts
            this.observer = null;
            this.checkInterval = null;
        }

        start() {
            console.log("🔍 [CaptchaDetector] Starting...");

            // Initial check
            this.checkForCaptcha();

            // Periodic check
            this.checkInterval = setInterval(
                () => this.checkForCaptcha(), 
                CONFIG.CAPTCHA_CHECK_INTERVAL
            );

            // MutationObserver for dynamic content
            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (this.isCaptchaElement(node)) {
                                this.handleCaptchaDetected(node);
                                return;
                            }
                            // Check children
                            const captchaChild = node.querySelector(
                                CONFIG.CAPTCHA_SELECTORS.join(',')
                            );
                            if (captchaChild) {
                                this.handleCaptchaDetected(captchaChild);
                                return;
                            }
                        }
                    }
                }
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        stop() {
            if (this.checkInterval) {
                clearInterval(this.checkInterval);
            }
            if (this.observer) {
                this.observer.disconnect();
            }
        }

        isCaptchaElement(element) {
            return CONFIG.CAPTCHA_SELECTORS.some(selector => {
                try {
                    return element.matches && element.matches(selector);
                } catch (e) {
                    return false;
                }
            });
        }

        checkForCaptcha() {
            if (this.isProcessing) return;

            for (const selector of CONFIG.CAPTCHA_SELECTORS) {
                const element = document.querySelector(selector);
                if (element) {
                    this.handleCaptchaDetected(element);
                    return;
                }
            }
        }

        async handleCaptchaDetected(element) {
            // Cooldown check
            const now = Date.now();
            if (now - this.lastCaptchaTime < this.captchaCooldown) {
                return;
            }

            if (this.isProcessing) return;
            this.isProcessing = true;
            this.lastCaptchaTime = now;

            console.log("🤖 [CaptchaDetector] CAPTCHA DETECTED:", element);

            // Show visual indicator
            this.showCaptchaOverlay();

            // Wait 2-5 seconds to let the widget settle
            const waitTime = 2000 + Math.floor(Math.random() * 3000);
            console.log(`⏳ [CaptchaDetector] Waiting ${waitTime}ms for CAPTCHA to settle...`);
            await sleep(waitTime);

            // Get click coordinates
            const coords = await this.getCaptchaClickCoordinates(element);

            if (coords) {
                console.log(`📍 [CaptchaDetector] Click coordinates: (${coords.x}, ${coords.y})`);

                // Show tap indicator
                window.showTap(coords.x, coords.y);

                // Request hardware click
                const success = await this.hardwareBridge.sendClick(
                    coords.x,
                    coords.y,
                    'turnstile-checkbox',
                    coords.iframeOffset
                );

                if (success) {
                    console.log("✅ [CaptchaDetector] Hardware click request sent");
                } else {
                    console.error("❌ [CaptchaDetector] Failed to send hardware click request");
                }
            } else {
                console.error("[CaptchaDetector] Could not determine click coordinates");
            }

            // Hide overlay after delay
            setTimeout(() => this.hideCaptchaOverlay(), 3000);

            this.isProcessing = false;
        }

        async getCaptchaClickCoordinates(element) {
            // Check if it's an iframe
            if (element.tagName === 'IFRAME') {
                return this.getIframeClickCoordinates(element);
            }

            // Direct element
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            return {
                x: x + window.scrollX,
                y: y + window.scrollY,
                iframeOffset: null
            };
        }

        async getIframeClickCoordinates(iframe) {
            const iframeRect = iframe.getBoundingClientRect();

            // Try to access iframe content (same-origin only)
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

                // Find the clickable element inside iframe
                for (const selector of CONFIG.TURNSTILE_CLICK_SELECTORS) {
                    const clickTarget = iframeDoc.querySelector(selector);
                    if (clickTarget) {
                        const targetRect = clickTarget.getBoundingClientRect();

                        // Calculate absolute screen position
                        const x = iframeRect.left + targetRect.left + targetRect.width / 2;
                        const y = iframeRect.top + targetRect.top + targetRect.height / 2;

                        console.log(`[CaptchaDetector] Found click target: ${selector}`);

                        return {
                            x: x,
                            y: y,
                            iframeOffset: {
                                left: iframeRect.left,
                                top: iframeRect.top
                            }
                        };
                    }
                }
            } catch (e) {
                // Cross-origin iframe - can't access content
                console.log("[CaptchaDetector] Cross-origin iframe, using center coordinates");
            }

            // Fallback: click center of iframe
            return {
                x: iframeRect.left + iframeRect.width / 2,
                y: iframeRect.top + iframeRect.height / 2,
                iframeOffset: {
                    left: iframeRect.left,
                    top: iframeRect.top
                }
            };
        }

        showCaptchaOverlay() {
            let overlay = document.querySelector('.captcha-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'captcha-overlay';
                document.body.appendChild(overlay);
            }
        }

        hideCaptchaOverlay() {
            const overlay = document.querySelector('.captcha-overlay');
            if (overlay) {
                overlay.remove();
            }
        }
    }

    // ================================
    // COPILOT BRIDGE (SESSION-AWARE)
    // Handles conversation creation and message sending
    // ================================
    const CopilotBridge = {
        status: "idle",
        responseText: "",
        lastConvId: null,
        currentRequestId: null,
        activeSocket: null,

        /**
         * Create a new conversation via POST /api/conversations endpoint.
         * Returns the new conversation ID or null on failure.
         * 
         * Network log shows:
         *   POST https://copilot.microsoft.com/c/api/conversations
         *   Response: {"type":"chat","id":"GCCeAtUeehcop149BbeDW","title":"","updatedAt":"..."}
         * 
         * @returns {Promise<string|null>}
         */
        async startNewConversation() {
            console.log("🆕 [CopilotBridge] Creating new conversation via POST /api/conversations...");

            return new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', CONFIG.COPILOT_CONVERSATIONS_URL, true);
                xhr.setRequestHeader('Accept', 'application/json');
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.withCredentials = true;
                xhr.timeout = CONFIG.API_TIMEOUT;

                xhr.onreadystatechange = function() {
                    if (xhr.readyState === 4) {
                        if (xhr.status === 200 || xhr.status === 201) {
                            try {
                                const data = JSON.parse(xhr.responseText);
                                // The conversation ID is in the "id" field
                                const convId = data.id || null;
                                
                                if (convId) {
                                    console.log(`✅ [CopilotBridge] New conversation created: ${convId}`);
                                } else {
                                    console.warn("[CopilotBridge] /api/conversations returned no ID:", data);
                                }
                                resolve(convId);
                            } catch(e) {
                                console.error("[CopilotBridge] Failed to parse response:", e);
                                resolve(null);
                            }
                        } else {
                            console.error(`[CopilotBridge] /api/conversations failed with status: ${xhr.status}`);
                            resolve(null);
                        }
                    }
                };

                xhr.onerror = () => {
                    console.error("[CopilotBridge] Network error on /api/conversations");
                    resolve(null);
                };

                xhr.ontimeout = () => {
                    console.error("[CopilotBridge] Timeout on /api/conversations");
                    resolve(null);
                };

                // Send empty body - matches browser behavior
                xhr.send(JSON.stringify({}));
            });
        },

        /**
         * Extract conversation ID from current URL as fallback.
         * URL format: /chats/[conversationId]
         * 
         * @returns {string|null}
         */
        extractConvIdFromUrl() {
            const urlMatch = window.location.pathname.match(/\/chats\/([a-zA-Z0-9_-]+)/);
            if (urlMatch && urlMatch[1]) {
                console.log(`📌 [CopilotBridge] Extracted convId from URL: ${urlMatch[1]}`);
                return urlMatch[1];
            }
            return null;
        },

        /**
         * Send a message to Copilot and handle streaming response.
         * 
         * @param {string} text - The message to send
         * @param {string|null} convIdOverride - Explicit conversation ID to use
         * @param {function} onChunk - Called with (fullText, chunk, usedConvId) for each chunk
         * @param {function} onDone - Called with (finalText, usedConvId) when complete
         */
        async askCopilot(text, convIdOverride, onChunk, onDone) {
            const requestId = generateId();
            this.currentRequestId = requestId;
            this.status = "busy";
            this.responseText = "";
            
            // Store original WebSocket to bypass any interceptors
            const OriginalWebSocket = window.WebSocket;

            let convId = convIdOverride || null;

            // Step 1: Get or create conversation ID
            if (!convId) {
                // Create a new conversation via POST /api/conversations
                convId = await this.startNewConversation();
                
                if (convId) {
                    console.log(`📌 [CopilotBridge] Created new conversation: ${convId}`);
                } else {
                    // Fallback: extract from URL if API failed
                    convId = this.extractConvIdFromUrl();
                    if (convId) {
                        console.log(`📌 [CopilotBridge] Using URL fallback: ${convId}`);
                    }
                }
            } else {
                console.log(`📌 [CopilotBridge] Using provided conversation ID: ${convId}`);
            }

            // Step 2: Validate we have a conversation ID
            if (!convId) {
                const errorMsg = "Error: Could not obtain conversation ID. Check browser state.";
                console.error("[CopilotBridge] " + errorMsg);
                this.responseText = errorMsg;
                this.status = "idle";
                this.lastConvId = null;
                onDone(this.responseText, null);
                return;
            }

            this.lastConvId = convId;

            // Step 3: Connect to Copilot WebSocket API
            console.log(`🔌 [CopilotBridge] Connecting to chat WebSocket for conv: ${convId}`);
            
            const apiSocket = new OriginalWebSocket(CONFIG.COPILOT_CHAT_URL);
            this.activeSocket = apiSocket;
            let assistantMessageId = null;
            let doneFired = false;

            // Connection timeout
            const connectionTimeout = setTimeout(() => {
                if (this.status === "busy") {
                    console.error("[CopilotBridge] WebSocket connection timeout");
                    apiSocket.close();
                    this.responseText = "Error: WebSocket connection timeout.";
                    this.status = "idle";
                    onDone(this.responseText, convId);
                }
            }, CONFIG.WEBSOCKET_TIMEOUT);

            apiSocket.onopen = () => {
                console.log("✅ [CopilotBridge] WebSocket connected");
                
                // Send setOptions - NO DELIMITER (matches Python exactly)
                apiSocket.send(JSON.stringify({
                    "event": "setOptions",
                    "supportedFeatures": [
                        "partial-generated-images",
                        "side-by-side-comparison",
                        "session-duration-nudge",
                        "compose-email-html"
                    ],
                    "supportedCards": [
                        "weather", "local", "image", "sports", "video",
                        "healthcareEntity", "healthcareInfo", "chart",
                        "safetyHelpline", "quiz", "finance", "recipe", "personal"
                    ]
                }));

                // Send reportLocalConsents - NO DELIMITER
                apiSocket.send(JSON.stringify({
                    "event": "reportLocalConsents",
                    "grantedConsents": []
                }));

                // Send message - NO DELIMITER and NO messageId (matches Python exactly)
                // This matches the network log exactly:
                // {"event":"send","conversationId":"GCCeAtUeehcop149BbeDW","content":[{"type":"text","text":"hi"}],"mode":"smart","context":{}}
                apiSocket.send(JSON.stringify({
                    "event": "send",
                    "conversationId": convId,
                    "content": [{"type": "text", "text": text}],
                    "mode": "smart",
                    "context": {}
                }));

                console.log(`📤 [CopilotBridge] Message sent: "${text.substring(0, 50)}..."`);
            };

            apiSocket.onmessage = (event) => {
                // Check if this request was cancelled
                if (this.currentRequestId !== requestId) {
                    return;
                }

                const msg = safeParse(event.data);
                if (!msg) return;

                if (msg.event === 'startMessage') {
                    assistantMessageId = msg.messageId;
                    console.log(`🤖 [CopilotBridge] Assistant message started: ${assistantMessageId}`);
                    
                } else if (msg.event === 'appendText' && msg.text) {
                    // Only append text from the assistant, not user echo
                    if (!assistantMessageId || msg.messageId === assistantMessageId) {
                        this.responseText += msg.text;
                        
                        // Call onChunk callback if provided
                        if (onChunk && typeof onChunk === 'function') {
                            onChunk(this.responseText, msg.text, convId);
                        }
                    }
                    
                } else if (msg.event === 'done' || msg.event === 'error') {
                    clearTimeout(connectionTimeout);
                    
                    if (msg.event === 'error') {
                        console.error("[CopilotBridge] Server error:", msg);
                    }
                    
                    apiSocket.close();
                    
                    if (!doneFired) {
                        doneFired = true;
                        this.status = "idle";
                        
                        if (onDone && typeof onDone === 'function') {
                            onDone(this.responseText, convId);
                        }
                    }
                    
                    console.log(`✅ [CopilotBridge] Response complete (${this.responseText.length} chars)`);
                }
            };

            apiSocket.onerror = (err) => {
                clearTimeout(connectionTimeout);
                console.error("[CopilotBridge] WebSocket error:", err);
                
                this.responseText = "Error: Fatal WebSocket Error.";
                this.status = "idle";
                
                if (!doneFired && onDone && typeof onDone === 'function') {
                    doneFired = true;
                    onDone(this.responseText, convId);
                }
            };

            apiSocket.onclose = (event) => {
                clearTimeout(connectionTimeout);
                
                if (this.status === "busy" && !doneFired) {
                    this.status = "idle";
                    
                    if (onDone && typeof onDone === 'function') {
                        doneFired = true;
                        onDone(this.responseText, convId);
                    }
                }
                
                console.log(`🔌 [CopilotBridge] WebSocket closed (code: ${event.code})`);
            };
        },

        /**
         * Cancel any ongoing request.
         */
        cancel() {
            this.currentRequestId = null;
            if (this.activeSocket) {
                this.activeSocket.close();
                this.activeSocket = null;
            }
            this.status = "idle";
            console.log("🚫 [CopilotBridge] Request cancelled");
        },

        /**
         * Get current status.
         */
        getStatus() {
            return {
                status: this.status,
                responseLength: this.responseText.length,
                lastConvId: this.lastConvId
            };
        }
    };

    // Expose CopilotBridge globally for debugging
    window.CopilotBridge = CopilotBridge;

    // ================================
    // BACKEND WSS CONNECTION (SESSION-AWARE)
    // Handles communication with the external backend server
    // ================================
    class BackendConnection {
        constructor() {
            this.ws = null;
            this.connected = false;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = CONFIG.MAX_RECONNECT_ATTEMPTS;
        }

        connect() {
            console.log(`🔌 [Backend] Connecting to ${CONFIG.BACKEND_WSS_URL}...`);
            
            this.ws = new WebSocket(CONFIG.BACKEND_WSS_URL);

            this.ws.onopen = () => {
                console.log("✅ [Backend] Connected to WSS");
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateStatusIndicator("connected");
            };

            this.ws.onmessage = async (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    console.error("[Backend] Failed to parse message:", e);
                    return;
                }

                if (!data.message) {
                    console.warn("[Backend] Received message without 'message' field:", data);
                    return;
                }

                await this.handleIncomingMessage(data);
            };

            this.ws.onclose = () => {
                this.connected = false;
                this.updateStatusIndicator("disconnected");
                console.log("❌ [Backend] WSS closed. Reconnecting...");

                if (this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    setTimeout(() => this.connect(), CONFIG.RECONNECT_DELAY);
                }
            };

            this.ws.onerror = (err) => {
                console.error("[Backend] WSS error:", err);
            };
        }

        /**
         * Handle incoming message from backend with session resolution.
         */
        async handleIncomingMessage(data) {
            // Parse session arguments (matches Python parse_session_args exactly)
            const { explicitConvId, sessionId, reuseSession } = SessionManager.parseArgs(data);
            
            // Also check for OpenAI model-based session hints
            let finalSessionId = sessionId;
            let finalReuseSession = reuseSession;
            
            if (!explicitConvId && !sessionId && !reuseSession && data.model) {
                const modelSession = SessionManager.parseFromModelString(data.model);
                finalSessionId = modelSession.sessionId;
                finalReuseSession = modelSession.reuseSession;
            }
            
            // Resolve which conversation ID to use (matches Python resolve_conv_id exactly)
            const { convId, sessionKey } = SessionManager.resolve(
                explicitConvId, 
                finalSessionId, 
                finalReuseSession
            );

            console.log(
                `📨 [Backend] Message received\n` +
                `   message: "${data.message.substring(0, 50)}..."\n` +
                `   model: ${data.model || 'default'}\n` +
                `   session_id: ${finalSessionId || 'none'}\n` +
                `   reuse_session: ${finalReuseSession}\n` +
                `   resolved_conv: ${convId || 'will create fresh'}\n` +
                `   session_key: ${sessionKey}`
            );

            // Track whether onDone has fired
            let doneFired = false;

            // Send message to Copilot
            CopilotBridge.askCopilot(
                data.message,
                convId,   // Pass resolved ID (or null for fresh)
                
                // onChunk: stream partial text to backend
                (fullText, chunk, usedConvId) => {
                    // Store the usedConvId opportunistically
                    SessionManager.store(sessionKey, usedConvId);

                    this.send({
                        type: "chunk",
                        content: chunk,
                        full: fullText,
                        conversation_id: usedConvId,
                        session_id: finalSessionId || null
                    });
                },
                
                // onDone: send completion
                (finalText, usedConvId) => {
                    if (doneFired) return;
                    doneFired = true;

                    // Persist the conversation ID for future reuse
                    SessionManager.store(sessionKey, usedConvId);

                    this.send({
                        type: "done",
                        content: finalText,
                        conversation_id: usedConvId,
                        session_id: finalSessionId || null,
                        reused: convId !== null   // true if we continued existing thread
                    });

                    console.log(
                        `✅ [Backend] Response complete\n` +
                        `   conv: ${usedConvId}\n` +
                        `   sessions: ${JSON.stringify(SessionManager.list())}`
                    );
                }
            );
        }

        /**
         * Send message to backend.
         */
        send(data) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(data));
            }
        }

        /**
         * Update status indicator.
         */
        updateStatusIndicator(status) {
            let indicator = document.querySelector('.bridge-status');
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = 'bridge-status';
                document.body.appendChild(indicator);
            }
            
            const colors = {
                connected: '#0f0',
                disconnected: '#f00',
                busy: '#ff0'
            };
            
            indicator.style.color = colors[status] || '#888';
            indicator.textContent = `Bridge: ${status} | Sessions: ${Object.keys(SessionManager.list()).length}`;
        }
    }

    // ================================
    // AUTO-INITIALIZATION
    // ================================
    async function autoInitialize() {
        console.log("🚀 [AutoInit] Starting...");

        // Wait for page to load
        console.log("⏳ [AutoInit] Waiting for page to load...");
        await sleep(3000);

        // Look for input area
        let inputArea = null;
        for (let i = 0; i < 50; i++) {
            inputArea = document.querySelector(
                'textarea[data-testid="composer-input"], textarea#userInput'
            );
            if (inputArea) break;
            await sleep(500);
        }

        if (inputArea) {
            console.log("⌨️ [AutoInit] Typing 'hi'...");

            // Visual indicator
            const rect = inputArea.getBoundingClientRect();
            window.showTap(rect.left + rect.width / 2, rect.top + rect.height / 2);

            // Focus and type
            inputArea.focus();
            setNativeValue(inputArea, 'hi');

            await sleep(1000);

            // Click send
            const sendBtn = document.querySelector('button[data-testid="submit-button"]');
            if (sendBtn) {
                console.log("[AutoInit] Clicking Send...");
                const sRect = sendBtn.getBoundingClientRect();
                window.showTap(sRect.left + sRect.width / 2, sRect.top + sRect.height / 2);
                sendBtn.click();
            }
        } else {
            console.warn("[AutoInit] Input area not found");
        }

        await sleep(5000);

        // Check for existing captcha
        const turnstile = document.querySelector('#cf-turnstile, [id^="cf-chl-widget"]');
        if (turnstile) {
            console.log("🎯 [AutoInit] Turnstile detected!");
        }

        console.log("✅ [AutoInit] Complete.");
    }

    // ================================
    // MAIN STARTUP
    // ================================
    async function main() {
        console.log("=".repeat(60));
        console.log("🚀 Copilot Bridge Extension Starting");
        console.log("   Version: 2.1.0");
        console.log("   Session handling: Fresh by default");
        console.log("   API: POST /api/conversations for new conversations");
        console.log("=".repeat(60));

        // Initialize hardware click bridge
        const hardwareBridge = new HardwareClickBridge();

        // Start captcha detector
        const captchaDetector = new CaptchaDetector(hardwareBridge);

        // Initialize backend connection
        const backendConnection = new BackendConnection();

        // Expose for debugging
        window.bridgeDebug = {
            SessionManager,
            CopilotBridge,
            hardwareBridge,
            captchaDetector,
            backendConnection,
            
            // Convenience methods
            listSessions: () => SessionManager.list(),
            clearSessions: () => SessionManager.clear(),
            getStatus: () => CopilotBridge.getStatus()
        };

        // 1. Run Auto-Init (non-blocking)
        autoInitialize();

        // 2. Connect to backend immediately
        backendConnection.connect();

        // 3. Connect to hardware click server (background)
        hardwareBridge.connect()
            .then(() => {
                console.log("✅ [HardwareClick] Bridge ready");
                captchaDetector.start();
            })
            .catch(e => {
                console.warn("⚠️ [HardwareClick] Server not available:", e.message);
                // Still start captcha detector - it will work when server connects
                captchaDetector.start();
            });

        console.log("=".repeat(60));
        console.log("✅ Copilot Bridge Initialized");
        console.log("   - CAPTCHA detection: Active");
        console.log("   - Session management: Fresh by default");
        console.log("   - Debug: window.bridgeDebug");
        console.log("=".repeat(60));
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();
