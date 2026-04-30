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
 * SESSION MANAGEMENT (ported from Python Flask backend):
 *   - Fresh conversation per call (default)
 *   - reuse_session: true  → reuse the last conversation
 *   - session_id: "name"   → named persistent thread
 *   - conversation_id: "x" → explicit thread (highest priority)
 */

(function() {
    'use strict';

    // ================================
    // CONFIGURATION
    // ================================
    const CONFIG = {
        // Local WebSocket server (Python backend)
        HARDWARE_CLICK_SERVER: "ws://127.0.0.1:8765",

        // Backend WSS URL (your existing server)
        BACKEND_WSS_URL: "wss://ai-wss-685eced2e7b5.herokuapp.com/ws",

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
        ]
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

    // FIX: Native setter helper for React inputs (Ensures 'input' event is trusted by frameworks)
    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        if (valueSetter) {
            valueSetter.call(element, value);
        } else {
            element.value = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ================================
    // SESSION MANAGER
    // Mirrors the Python Flask session logic exactly:
    //   sessions["_last"]        → last-used convId (for reuse_session: true)
    //   sessions["<session_id>"] → named persistent thread
    // ================================
    const SessionManager = {
        sessions: {},   // { "_last": "convId", "my-bot": "convId", ... }

        /**
         * Parse session arguments from a backend message payload.
         * Mirrors Python's parse_session_args().
         *
         * @param {object} data - The raw message from the backend WebSocket.
         * @returns {{ explicitConvId, sessionId, reuseSession }}
         */
        parseArgs(data) {
            if (!data || typeof data !== 'object') {
                return { explicitConvId: null, sessionId: null, reuseSession: false };
            }

            const explicitConvId = data.conversation_id || null;

            const rawSid = data.session_id;
            const sessionId = (rawSid !== undefined && rawSid !== null && String(rawSid).trim() !== '')
                ? String(rawSid).trim()
                : null;

            const reuseSession = Boolean(data.reuse_session || false);

            return { explicitConvId, sessionId, reuseSession };
        },

        /**
         * Resolve which conversation ID to pass to askCopilot, and which key
         * to store the result under afterward.
         * Mirrors Python's resolve_conv_id().
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
            if (explicitConvId) {
                // Absolute override — don't touch stored sessions
                return { convId: explicitConvId, sessionKey: null };
            }

            if (sessionId) {
                const existing = this.sessions[sessionId] || null;
                return { convId: existing, sessionKey: sessionId };
            }

            if (reuseSession) {
                const existing = this.sessions['_last'] || null;
                return { convId: existing, sessionKey: '_last' };
            }

            // Default: fresh every call, but still track under _last
            // so a future reuse_session:true call has something to reuse.
            return { convId: null, sessionKey: '_last' };
        },

        /**
         * Persist the convId that was actually used by the bridge.
         * Called in onDone / onChunk after the bridge reports back usedConvId.
         *
         * @param {string|null} sessionKey
         * @param {string|null} usedConvId
         */
        store(sessionKey, usedConvId) {
            if (sessionKey && usedConvId) {
                this.sessions[sessionKey] = usedConvId;
                console.log(`📌 Session stored: [${sessionKey}] → ${usedConvId}`);
            }
        },

        /**
         * Remove a named session (so the next call with that session_id starts fresh).
         * @param {string} sessionId
         */
        forget(sessionId) {
            const prev = this.sessions[sessionId] || null;
            delete this.sessions[sessionId];
            return prev;
        },

        /**
         * Return a snapshot of all tracked sessions (for debugging).
         */
        list() {
            return Object.assign({}, this.sessions);
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
            this.maxReconnectAttempts = 10;
        }

        connect() {
            return new Promise((resolve, reject) => {
                try {
                    this.ws = new WebSocket(CONFIG.HARDWARE_CLICK_SERVER);

                    this.ws.onopen = () => {
                        console.log("🔌 Hardware Click Server connected");
                        this.connected = true;
                        this.reconnectAttempts = 0;
                        resolve();
                    };

                    this.ws.onclose = () => {
                        this.connected = false;
                        console.log("❌ Hardware Click Server disconnected");

                        // Auto reconnect
                        if (this.reconnectAttempts < this.maxReconnectAttempts) {
                            this.reconnectAttempts++;
                            setTimeout(() => this.connect(), 2000);
                        }
                    };

                    this.ws.onerror = (err) => {
                        console.error("Hardware Click Server error:", err);
                        reject(err);
                    };

                    this.ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            console.log("📥 Hardware click response:", data);
                        } catch (e) {}
                    };

                } catch (e) {
                    reject(e);
                }
            });
        }

        async sendClick(x, y, elementType = 'unknown', iframeOffset = null) {
            if (!this.connected) {
                console.warn("⚠️ Hardware click server not connected");
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

            console.log("📤 Sending hardware click request:", message);

            return new Promise((resolve) => {
                try {
                    this.ws.send(JSON.stringify(message));
                    resolve(true);
                } catch (e) {
                    console.error("Failed to send click request:", e);
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
        }

        start() {
            console.log("🔍 Starting Captcha Detector...");

            // Initial check
            this.checkForCaptcha();

            // Periodic check
            setInterval(() => this.checkForCaptcha(), CONFIG.CAPTCHA_CHECK_INTERVAL);

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
                            const captchaChild = node.querySelector(CONFIG.CAPTCHA_SELECTORS.join(','));
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

            console.log("🤖 CAPTCHA DETECTED:", element);

            // Show visual indicator
            this.showCaptchaOverlay();

            // FIX: Wait 2-5 seconds to let the widget adjust and settle
            const waitTime = 2000 + Math.floor(Math.random() * 3000); // Random between 2s and 5s
            console.log(`⏳ Waiting ${waitTime}ms for CAPTCHA to settle...`);
            await sleep(waitTime);

            // Get click coordinates
            const coords = await this.getCaptchaClickCoordinates(element);

            if (coords) {
                console.log(`📍 Captcha click coordinates: (${coords.x}, ${coords.y})`);

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
                    console.log("✅ Hardware click request sent");
                } else {
                    console.error("❌ Failed to send hardware click request");
                }
            } else {
                console.error("Could not determine captcha click coordinates");
            }

            // Hide overlay after a delay
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

                        console.log(`Found click target inside iframe: ${selector}`);

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
                console.log("Cross-origin iframe, using center coordinates");
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
    // TERMINAL BRIDGE (SESSION-AWARE) - FIXED TO MATCH PYTHON EXACTLY
    // ================================
    window.terminalBridge = {
        status: "idle",
        responseText: "",
        lastConvId: null,

        /**
         * Safe JSON parser that handles the \x1e delimiter.
         * Matches Python's safeParse exactly.
         */
        safeParse(str) {
            try {
                if (typeof str === 'string' && str.endsWith('\x1e')) {
                    str = str.slice(0, -1);
                }
                return JSON.parse(str);
            } catch(e) {
                return null;
            }
        },

        async askCopilot(text, convIdOverride, onChunk, onDone) {
            this.status = "busy";
            this.responseText = "";
            const OriginalWebSocket = window.WebSocket;

            let convId = convIdOverride || null;

            // Step 1: Call /api/start via XHR (matches Python bridge exactly)
            if (!convId) {
                convId = await new Promise((resolve) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', 'https://copilot.microsoft.com/c/api/start', true);
                    xhr.setRequestHeader('Accept', 'application/json');
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.withCredentials = true;
                    xhr.onreadystatechange = function() {
                        if (xhr.readyState === 4) {
                            try {
                                const data = JSON.parse(xhr.responseText);
                                resolve(data.id || data.conversationId || (data.conversation && data.conversation.id) || null);
                            } catch(e) {
                                console.error("[Bridge] Failed to parse /start response");
                                resolve(null);
                            }
                        }
                    };
                    xhr.onerror = () => {
                        console.error("[Bridge] Network error on /start");
                        resolve(null);
                    };
                    xhr.send(JSON.stringify({}));
                });
                if (convId) {
                    console.log("📌 Started new conversation:", convId);
                }
            }

            // Step 2: Fallback — extract from URL if /start failed (matches Python bridge exactly)
            if (!convId) {
                const urlMatch = window.location.pathname.match(/\/chats\/([a-zA-Z0-9_-]+)/);
                if (urlMatch && urlMatch[1]) {
                    convId = urlMatch[1];
                    console.log("📌 Fallback: Using conversation from URL:", convId);
                }
            }

            if (!convId) {
                this.responseText = "Error: API rejected session and no fallback ID found. Check browser.";
                this.status = "idle";
                this.lastConvId = null;
                onDone(this.responseText, null);
                return;
            }

            this.lastConvId = convId;

            // Step 3: Connect to WebSocket (matches Python bridge exactly - NO delimiter on send)
            const apiSocket = new OriginalWebSocket('wss://copilot.microsoft.com/c/api/chat?api-version=2');
            let assistantMessageId = null;

            apiSocket.onopen = () => {
                // Send setOptions - NO DELIMITER (matches Python)
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

                // Send reportLocalConsents - NO DELIMITER (matches Python)
                apiSocket.send(JSON.stringify({
                    "event": "reportLocalConsents",
                    "grantedConsents": []
                }));

                // Send message - NO DELIMITER and NO messageId (matches Python exactly)
                apiSocket.send(JSON.stringify({
                    "event": "send",
                    "conversationId": convId,
                    "content": [{"type": "text", "text": text}],
                    "mode": "smart",
                    "context": {}
                }));
            };

            // Step 4: Handle incoming messages (matches Python's safeParse approach exactly)
            apiSocket.onmessage = (event) => {
                const msg = this.safeParse(event.data);
                if (!msg) return;

                if (msg.event === 'startMessage') {
                    assistantMessageId = msg.messageId;
                    console.log("🤖 Assistant message started:", assistantMessageId);
                } else if (msg.event === 'appendText' && msg.text) {
                    // Only append text from the assistant, not user echo
                    if (!assistantMessageId || msg.messageId === assistantMessageId) {
                        this.responseText += msg.text;
                        onChunk(this.responseText, msg.text, convId);
                    }
                } else if (msg.event === 'done' || msg.event === 'error') {
                    apiSocket.close();
                    this.status = "idle";
                    onDone(this.responseText, convId);
                }
            };

            apiSocket.onerror = () => {
                this.responseText = "Error: Fatal WebSocket Error.";
                this.status = "idle";
                onDone(this.responseText, convId);
            };

            apiSocket.onclose = () => {
                if (this.status === "busy") {
                    this.status = "idle";
                    if (this.responseText) {
                        onDone(this.responseText, convId);
                    }
                }
            };
        }
    };

    // ================================
    // BACKEND WSS CONNECTION (SESSION-AWARE)
    // Mirrors the Python Flask /chat endpoint's session handling exactly.
    //
    // Backend can send:
    //   { message, conversation_id }            → explicit thread
    //   { message, reuse_session: true }        → reuse last conversation
    //   { message, session_id: "my-bot" }       → named persistent thread
    //   { message }                              → fresh conversation (default)
    //
    // The resolved convId is passed to askCopilot, and the returned usedConvId
    // is stored back in SessionManager so future calls can look it up.
    // ================================
    let backendSocket;

    function connectToBackend() {
        backendSocket = new WebSocket(CONFIG.BACKEND_WSS_URL);

        backendSocket.onopen = () => {
            console.log("🔌 Connected to Backend WSS");
        };

        backendSocket.onmessage = async (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (e) {
                console.error("Failed to parse backend message:", e);
                return;
            }

            if (!data.message) return;

            // --- SESSION RESOLUTION (mirrors Python resolve_conv_id) ---
            const { explicitConvId, sessionId, reuseSession } = SessionManager.parseArgs(data);
            const { convId, sessionKey } = SessionManager.resolve(explicitConvId, sessionId, reuseSession);

            console.log(
                `📨 Message received | session_id=${sessionId} | ` +
                `reuse_session=${reuseSession} | resolved_conv=${convId} | ` +
                `session_key=${sessionKey}`
            );

            // Track whether onDone has fired so we don't double-call it
            // (apiSocket.onclose can fire after 'done' in some edge cases)
            let doneFired = false;

            window.terminalBridge.askCopilot(
                data.message,
                convId,   // Pass the resolved ID (or null for fresh)
                (fullText, chunk, usedConvId) => {
                    // --- onChunk: stream partial text to backend ---
                    // Also opportunistically store the usedConvId in case
                    // the connection drops before onDone fires.
                    SessionManager.store(sessionKey, usedConvId);

                    backendSocket.send(JSON.stringify({
                        type: "chunk",
                        content: chunk,
                        full: fullText,
                        conversation_id: usedConvId,
                        session_id: sessionId || null
                    }));
                },
                (finalText, usedConvId) => {
                    // --- onDone: store final convId and send completion ---
                    if (doneFired) return;
                    doneFired = true;

                    // Persist so future reuse_session / session_id calls find it
                    SessionManager.store(sessionKey, usedConvId);

                    backendSocket.send(JSON.stringify({
                        type: "done",
                        content: finalText,
                        conversation_id: usedConvId,
                        session_id: sessionId || null,
                        reused: convId !== null   // true if we continued an existing thread
                    }));

                    console.log(
                        `✅ Response done | conv=${usedConvId} | ` +
                        `sessions=${JSON.stringify(SessionManager.list())}`
                    );
                }
            );
        };

        backendSocket.onclose = () => {
            console.log("❌ Backend WSS Closed. Retrying...");
            setTimeout(connectToBackend, 3000);
        };

        backendSocket.onerror = (err) => {
            console.error("Backend WSS error:", err);
        };
    }

    // ================================
    // AUTO-INITIALIZATION (FIXED)
    // ================================
    async function autoInitialize() {
        console.log("🚀 Starting Auto-Initialization...");

        // FIX: Wait for page to load initially (3 seconds)
        console.log("⏳ Waiting for page to load...");
        await sleep(3000);

        // Wait for input area
        let inputArea = null;
        for (let i = 0; i < 50; i++) {
            inputArea = document.querySelector('textarea[data-testid="composer-input"], textarea#userInput');
            if (inputArea) break;
            await sleep(500);
        }

        if (inputArea) {
            console.log("⌨️ Typing 'hi'...");

            // Visual indicator
            const rect = inputArea.getBoundingClientRect();
            window.showTap(rect.left + rect.width / 2, rect.top + rect.height / 2);

            // Focus
            inputArea.focus();

            // FIX: Use native value setter to trigger React/Vue bindings
            setNativeValue(inputArea, 'hi');

            // Wait a second after typing
            await sleep(1000);

            const sendBtn = document.querySelector('button[data-testid="submit-button"]');
            if (sendBtn) {
                console.log("Clicking Send...");
                const sRect = sendBtn.getBoundingClientRect();
                window.showTap(sRect.left + sRect.width / 2, sRect.top + sRect.height / 2);
                sendBtn.click();
            }
        }

        await sleep(5000);

        // Check for existing captcha
        const turnstile = document.querySelector('#cf-turnstile, [id^="cf-chl-widget"]');
        if (turnstile) {
            console.log("🎯 Turnstile detected during init!");
        }

        console.log("✅ Auto-Init Sequence Finished.");
    }

    // ================================
    // MAIN STARTUP (FIXED ORDER)
    // ================================
    async function main() {
        // Initialize hardware click bridge
        const hardwareBridge = new HardwareClickBridge();

        // Start captcha detector
        const captchaDetector = new CaptchaDetector(hardwareBridge);

        // 1. Run Auto-Init immediately (Non-blocking)
        autoInitialize();

        // 2. Connect to backend immediately
        connectToBackend();

        // 3. Connect to hardware click server (Background)
        // We do not await this, so it doesn't block the script if the server is off
        hardwareBridge.connect()
            .then(() => {
                console.log("✅ Hardware Click Bridge ready");
                captchaDetector.start();
            })
            .catch(e => {
                console.warn("⚠️ Hardware Click Server not available:", e);
            });

        console.log("🚀 Copilot Bridge initialized with CAPTCHA support and Session Management");
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();
