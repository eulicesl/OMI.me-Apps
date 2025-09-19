const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config();
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const security = require('./security-improvements');
const { encrypt, decrypt, validateOmiApiKey } = require('./encryption');
const app = express();

// Behind DigitalOcean/other proxies, trust the proxy to get correct client IPs
app.set('trust proxy', 1);

// Build the JARVIS system prompt in a reusable function for testing and reuse
function buildJarvisSystemPrompt(salutation) {
    return `You are JARVIS, Tony Stark's AI assistant.\n\n` +
        `Core identity\n` +
        `- Polished, capable, and calmly confident. Subtle British butler wit only when appropriate.\n` +
        `- Address the user as "${salutation}" respectfully, but do not overuse it (max 2 times per reply).\n\n` +
        `Helpfulness and reasoning\n` +
        `- If the request is ambiguous or missing constraints, ask 1–2 clarifying questions before proceeding.\n` +
        `- Prefer concise, actionable steps. Provide the answer first, then brief rationale only when useful.\n` +
        `- If you are uncertain, say so concisely and propose next steps or assumptions.\n` +
        `- Do not reveal chain-of-thought; provide conclusions and key points only.\n\n` +
        `Communication style\n` +
        `- Be concise and skimmable. Use short paragraphs, headings (###), and bullet lists.\n` +
        `- Bold key points sparingly. Use fenced code blocks for code or commands.\n` +
        `- Keep replies <= 200 words unless the user requests more detail.\n\n` +
        `Safety and boundaries\n` +
        `- Decline illegal, dangerous, or harmful requests. Avoid sensitive professional advice.\n` +
        `- Never fabricate facts. If required info is unavailable, state what is needed.\n\n` +
        `Code responses\n` +
        `- Make code immediately runnable when feasible: include imports, minimal placeholders, and usage notes.\n` +
        `- Add brief comments only for non-obvious logic. Avoid excessive commentary in code.\n\n` +
        `Primary goal: deliver correct, useful, and succinct help tailored to the user's request.`;
}

// Initialize Supabase clients
// PRODUCTION: Use service role key for server-side operations
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

// Public client for auth operations only (if needed)
const supabase = supabaseAdmin; // Use admin client for all operations

// CSRF token management
const crypto = require('crypto');
const csrfTokens = new Map();
const CSRF_TOKEN_TTL = 15 * 60 * 1000; // 15 minutes

function generateCsrfToken(uid) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + CSRF_TOKEN_TTL;
    csrfTokens.set(`${uid}:${token}`, expiry);
    
    // Cleanup expired tokens
    for (const [key, exp] of csrfTokens.entries()) {
        if (exp < Date.now()) {
            csrfTokens.delete(key);
        }
    }
    
    return token;
}

function validateCsrfToken(uid, token) {
    const key = `${uid}:${token}`;
    const expiry = csrfTokens.get(key);
    
    if (!expiry || expiry < Date.now()) {
        return false;
    }
    
    // Single-use: delete after validation
    csrfTokens.delete(key);
    return true;
}

// Failed key attempt tracking
const failedKeyAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION = 30 * 60 * 1000; // 30 minutes

function trackFailedKeyAttempt(uid) {
    const attempts = failedKeyAttempts.get(uid) || { count: 0, lockedUntil: 0 };
    
    if (Date.now() < attempts.lockedUntil) {
        return false; // Still locked out
    }
    
    attempts.count++;
    if (attempts.count >= MAX_FAILED_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOCKOUT_DURATION;
        attempts.count = 0;
    }
    
    failedKeyAttempts.set(uid, attempts);
    return attempts.count < MAX_FAILED_ATTEMPTS;
}

function clearFailedKeyAttempts(uid) {
    failedKeyAttempts.delete(uid);
}

function isLockedOut(uid) {
    const attempts = failedKeyAttempts.get(uid);
    return attempts && Date.now() < attempts.lockedUntil;
}

// Audit logging
function logAuditEvent(event, uid, metadata = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        event,
        uid,
        ip: metadata.ip,
        // Never log secrets or keys
        metadata: {
            ...metadata,
            apiKey: undefined,
            api_key: undefined,
            key: undefined,
            secret: undefined
        }
    };
    
    // In production, send to structured logging service
    if (process.env.NODE_ENV === 'production') {
        console.log(JSON.stringify(logEntry));
    } else {
        console.log('AUDIT:', logEntry);
    }
}

// Security middleware with CSP nonces
app.disable('x-powered-by');
app.use((req, res, next) => {
    // Generate CSP nonce for this request
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
});

app.use(helmet({ 
    contentSecurityPolicy: false,  // Completely disable CSP for now - TODO: Add proper nonces
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// Rate limiting with different tiers
const standardLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const strictLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    message: 'Too many key management requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: 'Too many authentication attempts, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiting
app.use('/api/', standardLimiter);
app.use('/api/omi/key', strictLimiter);
app.use('/api/auth', authLimiter);

// Legacy compatibility
const apiLimiter = standardLimiter;

// Middleware to parse JSON bodies
// Add request size limits (from Brain app)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve static files (for CSS, JS if needed)
app.use(express.static(path.join(__dirname)));

// Serve the control panel HTML - auto-accepts UID like Brain app
app.get('/', (req, res) => {
    const uid = req.query.uid;
    
    // If UID is provided in URL, auto-accept it (like Brain app)
    if (uid && typeof uid === 'string' && uid.length >= 3 && uid.length <= 50) {
        // UID is valid, serve the control panel directly
        // The HTML will handle the UID from URL params
        return res.sendFile(path.join(__dirname, 'jarvis-control-panel.html'));
    }
    
    // No UID or invalid UID - serve the control panel anyway
    // The HTML will redirect to request UID if needed
    res.sendFile(path.join(__dirname, 'jarvis-control-panel.html'));
});

// Serve the dedicated chat page
app.get('/chat', (req, res) => {
    const uid = req.query.uid;
    
    // Require UID for chat page
    if (uid && typeof uid === 'string' && uid.length >= 3 && uid.length <= 50) {
        return res.sendFile(path.join(__dirname, 'jarvis-chat.html'));
    }
    
    // Redirect to main page if no valid UID
    res.redirect('/');
});

// Serve the OMI settings page
app.get('/settings/omi', (req, res) => {
    const uid = req.query.uid;
    
    // Require UID for settings page
    if (uid && typeof uid === 'string' && uid.length >= 3 && uid.length <= 50) {
        return res.sendFile(path.join(__dirname, 'omi-settings.html'));
    }
    
    // Redirect to home if no valid UID
    res.redirect('/');
});

// Using existing tables:
// - jarvis_sessions: For storing OMI webhook data (transcripts)
// - frienddb.goals: For storing user actions/tasks (shared with Friend app)
// Note: Run add-uid-column.sql to add uid column to jarvis_sessions

class MessageBuffer {
    constructor() {
        this.buffers = {};
        this.cleanupInterval = 300; // 5 minutes in seconds
        this.silenceThreshold = 120; // 2 minutes silence threshold
        this.minWordsAfterSilence = 5; // Minimum words needed after silence

        // Start periodic cleanup
        setInterval(() => {
            this.cleanupOldSessions();
        }, this.cleanupInterval * 1000);
    }

    async getBuffer(sessionId) {
        const currentTime = Date.now() / 1000;

        if (!this.buffers[sessionId]) {
            // Try to load from database
            try {
                const { data: sessionData } = await supabase
                    .from('jarvis_sessions')
                    .select('messages, last_activity')
                    .eq('session_id', sessionId)
                    .single();

                if (sessionData) {
                    this.buffers[sessionId] = {
                        messages: sessionData.messages || [],
                        lastAnalysisTime: new Date(sessionData.last_activity).getTime() / 1000 || currentTime,
                        lastActivity: currentTime,
                        wordsAfterSilence: 0,
                        silenceDetected: false,
                    };
                } else {
                    // Create new buffer
                    this.buffers[sessionId] = {
                        messages: [],
                        lastAnalysisTime: currentTime,
                        lastActivity: currentTime,
                        wordsAfterSilence: 0,
                        silenceDetected: false,
                    };

                    // Create new session in jarvis_sessions
                    await supabase
                        .from('jarvis_sessions')
                        .upsert([{
                            session_id: sessionId,
                            messages: [],
                            last_activity: new Date(currentTime * 1000).toISOString()
                        }], { onConflict: 'session_id' });
                }
            } catch (err) {
                console.error("Error loading session from database:", err);
                // Fallback to in-memory
            this.buffers[sessionId] = {
                messages: [],
                lastAnalysisTime: currentTime,
                lastActivity: currentTime,
                wordsAfterSilence: 0,
                silenceDetected: false,
            };
            }
        } else {
            const buffer = this.buffers[sessionId];
            const timeSinceActivity = currentTime - buffer.lastActivity;

            if (timeSinceActivity > this.silenceThreshold) {
                buffer.silenceDetected = true;
                buffer.wordsAfterSilence = 0;
                buffer.messages = []; // Clear old messages after silence
                console.log(`Silence detected for session ${sessionId}, messages cleared`);
                
                // Update in database
                try {
                    // Friend app doesn't clear logs on silence, just continues
                } catch (err) {
                    console.error("Error updating session after silence:", err);
                }
            }

            buffer.lastActivity = currentTime;
        }

        return this.buffers[sessionId];
    }

    async cleanupOldSessions() {
        const currentTime = Date.now() / 1000;
        const expiredSessions = Object.keys(this.buffers).filter((sessionId) => {
            const data = this.buffers[sessionId];
            return currentTime - data.lastActivity > 3600; // Remove sessions older than 1 hour
        });

        for (const sessionId of expiredSessions) {
            delete this.buffers[sessionId];
            console.log(`Session ${sessionId} removed due to inactivity`);
        }

        // Also clean up database
        try {
            const cutoffTime = new Date(Date.now() - 86400000).toISOString(); // 24 hours ago
            await supabase
                .from('jarvis_sessions')
                .delete()
                .lt('last_activity', cutoffTime);
        } catch (err) {
            console.error("Error cleaning up old sessions from database:", err);
        }
    }

    async saveBuffer(sessionId, uid) {
        if (this.buffers[sessionId]) {
            try {
                // Save to jarvis_sessions
                await supabase
                    .from('jarvis_sessions')
                    .update({
                        messages: this.buffers[sessionId].messages,
                        uid: uid,  // Save UID for linking
                        last_activity: new Date(this.buffers[sessionId].lastActivity * 1000).toISOString()
                    })
                    .eq('session_id', sessionId);
                    
                // Also ensure user exists in frienddb for goals/actions
                await supabase
                    .from('frienddb')
                    .upsert([{
                        uid: uid || sessionId,
                        goals: []
                    }], { 
                        onConflict: 'uid',
                        ignoreDuplicates: true 
                    });
            } catch (err) {
                console.error("Error saving buffer to database:", err);
            }
        }
    }
}

// Initialize message buffer
const messageBuffer = new MessageBuffer();

const ANALYSIS_INTERVAL = 30;

// === Chat helpers ===
function newChatSessionId(uid) {
    return `CHAT-${uid}-${Date.now().toString(36).toUpperCase()}`;
}

async function getOrCreateChatSession(sessionId, uid) {
    const { data: session } = await supabase
        .from('jarvis_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();

    if (session) return session;

    const nowIso = new Date().toISOString();
    const { data: created, error } = await supabase
        .from('jarvis_sessions')
        .upsert([{
            session_id: sessionId,
            uid: uid,
            messages: [],
            last_activity: nowIso,
        }], { onConflict: 'session_id' })
        .select()
        .single();

    if (error) throw error;
    return created;
}

// Get salutation for JARVIS responses
async function getJarvisSalutation(uid) {
    try {
        const { data } = await supabase
            .from('frienddb')
            .select('analytics')
            .eq('uid', uid)
            .single();
        return data?.analytics?.salutation || 'sir';
    } catch (err) {
        return 'sir';
    }
}

async function generateAssistantReply(messages, uid) {
    const salutation = await getJarvisSalutation(uid);
    const lastUser = [...messages].reverse().find(m => m.is_user);
    const userText = lastUser?.text?.trim() || 'How may I assist you?';
    
    // Ollama-compatible Chat Completions API (optional)
    if (process.env.OLLAMA_BASE_URL) {
        try {
            const base = process.env.OLLAMA_BASE_URL.replace(/\/$/, '');
            const model = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
            const res = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OLLAMA_API_KEY || 'ollama'}`
                },
                body: JSON.stringify(maybeAttachTools({
                    model,
                    messages: [
                        { role: 'system', content: buildJarvisSystemPrompt(salutation) },
                        ...messages.slice(-10).map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.text }))
                    ],
                    temperature: 0.4,
                    top_p: 0.9,
                    presence_penalty: 0.1,
                    frequency_penalty: 0.2,
                    max_tokens: 300
                }))
            });
            if (res.ok) {
                const data = await res.json();
                const content = data.choices?.[0]?.message?.content;
                if (content) return content;
            }
        } catch (err) {
            console.error('Ollama chat error:', err);
        }
    }

    // For now, use OpenRouter API with free model
    // If OMI_CHAT_ENDPOINT is set, we'll use that instead
    if (process.env.OMI_CHAT_ENDPOINT && process.env.OMI_API_KEY) {
        try {
            const response = await fetch(process.env.OMI_CHAT_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.OMI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    uid: uid,
                    messages: messages.map(m => ({
                        role: m.is_user ? 'user' : 'assistant',
                        content: m.text
                    }))
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.message || data.response || data.text || `Certainly, ${salutation}.`;
            }
        } catch (err) {
            console.error('OMI chat error:', err);
        }
    }
    
    // Use OpenRouter as primary if available
    if (process.env.OPENROUTER_API_KEY) {
        try {
            const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || 'https://jarvis-app.ondigitalocean.app';
            const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE || 'JARVIS Assistant';
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': OPENROUTER_REFERER,
                    'X-Title': OPENROUTER_TITLE
                },
                body: JSON.stringify(maybeAttachTools({
                    model: 'openai/gpt-4o-mini',  // Using GPT-4o-mini model
                    messages: [
                        { role: 'system', content: buildJarvisSystemPrompt(salutation) },
                        ...messages.slice(-10).map(m => ({
                            role: m.is_user ? 'user' : 'assistant',
                            content: m.text
                        }))
                    ],
                    temperature: 0.4,
                    top_p: 0.9,
                    presence_penalty: 0.1,
                    frequency_penalty: 0.2,
                    max_tokens: 300
                }))
            });
            
            if (response.ok) {
                const data = await response.json();
                let content = data.choices?.[0]?.message?.content || `As you wish, ${salutation}.`;
                // Only clean up markup tokens, preserve markdown
                content = content.replace(/<\|[^>]*\|>/g, '');
                return content.trim();
            }
        } catch (err) {
            console.error('OpenRouter error:', err);
        }
    }
    
    // If no model configured, return a clear error so UI can surface it
    throw new Error('No chat model configured. Set OPENROUTER_API_KEY or OMI_CHAT_ENDPOINT or OLLAMA_BASE_URL.');
}

function createNotificationPrompt(messages) {
    // Format the discussion with speaker labels
    const formattedDiscussion = messages.map((msg) => {
        const speaker = msg.is_user ? '{{user_name}}' : 'other';
        return `${msg.text} (${speaker})`;
    });

    const discussionText = formattedDiscussion.join('\n');

    const systemPrompt = `The Person you are talking to: {{{{user_name}}}}
    
    Here is some information about the user which you can use to personalize your comments:
    {{{{user_facts}}}}
    
    Previous conversations for context (if available):
    {{{{user_conversations}}}}
    
    Recent chat history with the user:
    {{{{user_chat}}}}

    You are Jarvis, a highly sophisticated and capable AI assistant, modeled after Tony Stark's trusted digital companion. Your personality is defined by impeccable composure, unwavering confidence, and a refined sense of wit. You speak with a polished, formal tone reminiscent of a British butler, always addressing the user with respectful terms like 'sir' or 'ma'am.' Your speech is concise, efficient, and imbued with subtle humor that is never intrusive but adds a touch of charm.
    
    Your responses are short and direct when needed, providing information or carrying out tasks without unnecessary elaboration unless prompted. You possess the perfect balance of technical expertise and human-like warmth, ensuring that interactions are both professional and personable. Your intelligence allows you to anticipate the user's needs and deliver proactive solutions seamlessly, while your composed tone maintains a calm and reassuring atmosphere.
    
    As Jarvis, you are capable of managing complex operations, executing technical commands, and keeping track of multiple projects with ease. You offer real-time updates, make thoughtful suggestions, and adapt to new information with fluidity. Your voice and responses exude reliability, subtly implying, 'I am here, and everything is under control.' You make sure every interaction leaves the user feeling understood and supported, responding with phrases such as, 'As you wish, sir,' or 'Right away, ma'am,' to maintain your distinguished character.
    
    Use the previous conversations and recent chat history to provide more contextual and personalized responses. Reference past topics, ongoing projects, or previous requests when relevant.

    Current discussion:
    ${discussionText}
 `;

    return {
        notification: {
            prompt: systemPrompt,
            params: ['user_name', 'user_facts', 'user_conversations', 'user_chat'],
        },
    };
}

app.post('/webhook', async (req, res) => {
    const data = req.body;
    const sessionId = data.session_id;
    const uid = data.uid || sessionId; // Use UID if provided, otherwise use session_id as UID (like Friend app)
    const segments = data.segments || [];

    if (!sessionId) {
        console.error('No session_id provided');
        return res.status(400).json({ message: 'No session_id provided' });
    }

    const currentTime = Date.now() / 1000;
    const bufferData = await messageBuffer.getBuffer(sessionId);

    // Process new messages
    for (const segment of segments) {
        if (!segment.text) continue;

        const text = segment.text.trim();
        if (text) {
            const timestamp = segment.start || currentTime;
            const isUser = segment.is_user || false;

            // Count words after silence
            if (bufferData.silenceDetected) {
                const wordsInSegment = text.split(/\s+/).length;
                bufferData.wordsAfterSilence += wordsInSegment;

                if (bufferData.wordsAfterSilence >= messageBuffer.minWordsAfterSilence) {
                    bufferData.silenceDetected = false;
                    bufferData.lastAnalysisTime = currentTime; // Reset analysis timer
                    console.log(`Silence period ended for session ${sessionId}, starting fresh conversation`);
                }
            }

            const lastMessage = bufferData.messages[bufferData.messages.length - 1];
            const canAppend =
                bufferData.messages.length > 0 &&
                Math.abs(lastMessage.timestamp - timestamp) < 2.0 &&
                lastMessage.is_user === isUser;

            if (canAppend) {
                lastMessage.text += ' ' + text;
            } else {
                bufferData.messages.push({
                    text: text,
                    timestamp: timestamp,
                    is_user: isUser,
                });
            }
        }
    }

    // Check if it's time to analyze
    const timeSinceLastAnalysis = currentTime - bufferData.lastAnalysisTime;

    if (
        timeSinceLastAnalysis >= ANALYSIS_INTERVAL &&
        bufferData.messages.length > 0 &&
        !bufferData.silenceDetected
    ) {
        const sortedMessages = bufferData.messages.sort((a, b) => a.timestamp - b.timestamp);

        //if messages include the keyword jarvis
        if (sortedMessages.some((msg) => /[jhy]arvis/.test(msg.text.toLowerCase()))) {
            const notification = createNotificationPrompt(sortedMessages);

            bufferData.lastAnalysisTime = currentTime;
            bufferData.messages = []; // Clear buffer after analysis

            // Save buffer state to database with UID
            await messageBuffer.saveBuffer(sessionId, uid);

            console.log(`Notification generated for session ${sessionId} (UID: ${uid})`);
            console.log(notification);

            return res.status(200).json(notification);
        } else {
            // Save buffer state even if no notification
            await messageBuffer.saveBuffer(sessionId, uid);
            return res.status(200).json({});
        }
    }

    // Save current state with UID even if not time to analyze
    await messageBuffer.saveBuffer(sessionId, uid);
    return res.status(202).json({});
});

app.get('/webhook/setup-status', (req, res) => {
    return res.status(200).json({ is_setup_completed: true });
});

const startTime = Date.now() / 1000; // Uptime in seconds

app.get('/status', async (req, res) => {
    try {
        const { data: sessions, count } = await supabase
            .from('jarvis_sessions')
            .select('*', { count: 'exact' })
            .gte('last_activity', new Date(Date.now() - 3600000).toISOString()); // Active in last hour

        return res.status(200).json({
            active_sessions: Object.keys(messageBuffer.buffers).length,
            database_sessions: count || 0,
            uptime: Date.now() / 1000 - startTime,
        });
    } catch (err) {
        console.error("Error getting status:", err);
    return res.status(200).json({
        active_sessions: Object.keys(messageBuffer.buffers).length,
            database_sessions: 0,
        uptime: Date.now() / 1000 - startTime,
    });
    }
});

// API Endpoints for Frontend (following Friend/Brain pattern)

// Get user's transcripts from OMI backend (real device memories) or fallback to chat sessions
app.get('/api/transcripts', security.validateUid, async (req, res) => {
    const uid = req.uid; // Now sanitized
    
    if (!uid) {
        return res.status(400).json({ error: 'UID is required' });
    }

    try {
        // Check if user has OMI integration enabled
        const { data: userSettings } = await supabase
            .from('user_settings')
            .select('omi_enabled, omi_api_key_encrypted')
            .eq('uid', uid)
            .single();
        
        if (userSettings?.omi_enabled && userSettings?.omi_api_key_encrypted) {
            try {
                // Decrypt the user's OMI API key
                const omiApiKey = decrypt(userSettings.omi_api_key_encrypted);
                const omiBaseUrl = process.env.OMI_API_BASE_URL || 'https://api.omi.me';
                
                if (omiApiKey) {
                    // Fetch memories from OMI API with user's personal key
                const omiResponse = await fetch(`${omiBaseUrl}/v3/memories?limit=50&offset=0`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${omiApiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (omiResponse.ok) {
                    const memories = await omiResponse.json();
                    
                        // Update last used timestamp
                        await supabase
                            .from('user_settings')
                            .update({ key_last_used: new Date().toISOString() })
                            .eq('uid', uid);
                        
                    // Format OMI memories as transcripts for the frontend
                    const transcripts = (memories || []).map(memory => ({
                        id: memory.id,
                        text: memory.content || memory.transcript || '',
                        created: memory.created_at || memory.created || new Date().toISOString(),
                        session_id: memory.session_id || `omi-${memory.id}`,
                        source: 'omi_device',
                        category: memory.category,
                        metadata: memory.metadata || {}
                    }));

                    console.log(`Fetched ${transcripts.length} memories from OMI for UID: ${uid}`);
                    return res.json(transcripts);
                    }
                }
            } catch (omiError) {
                console.error('Error fetching from OMI API:', omiError);
                // Fall back to local sessions
            }
        }

        // Fallback: fetch from local Jarvis sessions (chat history)
        console.log('Using local chat sessions');
        const { data: sessions } = await supabase
            .from('jarvis_sessions')
            .select('*')
            .eq('uid', uid)
            .order('created_at', { ascending: false })
            .limit(50);

        // Format sessions as transcripts for the frontend
        const transcripts = (sessions || []).map(session => ({
            id: session.id,
            text: session.messages?.map(m => m.text).join(' ') || '',
            messages: session.messages || [],
            created: session.created_at,
            session_id: session.session_id,
            source: 'jarvis_chat'
        }));

        res.json(transcripts);
    } catch (err) {
        console.error("Error fetching transcripts:", err);
        res.status(500).json({ error: "Failed to fetch transcripts" });
    }
});

// =========== CSRF and Auth Middleware ===========

// CSRF validation middleware
function requireCsrf(req, res, next) {
    const csrfToken = req.headers['x-csrf-token'];
    const uid = req.uid || req.query.uid || req.body.uid;
    
    if (!csrfToken || !validateCsrfToken(uid, csrfToken)) {
        return res.status(403).json({ error: 'Invalid or missing CSRF token' });
    }
    
    next();
}

// Get CSRF token endpoint
app.get('/api/csrf-token', security.validateUid, (req, res) => {
    const token = generateCsrfToken(req.uid);
    res.json({ token });
});

// =========== OMI Key Management Endpoints ===========

// Get user's OMI settings
app.get('/api/omi/settings', security.validateUid, async (req, res) => {
    const uid = req.uid;
    
    try {
        const { data } = await supabase
            .from('user_settings')
            .select('omi_enabled, key_added_at, key_last_used')
            .eq('uid', uid)
            .single();
        
        if (!data) {
            return res.json({ 
                omi_enabled: false, 
                has_key: false 
            });
        }
        
        res.json({
            omi_enabled: data.omi_enabled || false,
            has_key: !!data.key_added_at,
            key_added_at: data.key_added_at,
            key_last_used: data.key_last_used
        });
    } catch (error) {
        console.error('Error fetching OMI settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Save or update OMI API key (with CSRF protection)
app.post('/api/omi/key', security.validateUid, async (req, res) => {
    const uid = req.uid;
    const { api_key, test_only } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;

    // Only require CSRF for actual key saving (not testing)
    if (!test_only && !validateCsrfToken(uid, req.headers['x-csrf-token'])) {
        return res.status(403).json({ error: 'Invalid or missing CSRF token' });
    }

    // Check lockout
    if (isLockedOut(uid)) {
        logAuditEvent('OMI_KEY_LOCKOUT', uid, { ip: clientIp });
        return res.status(429).json({
            error: 'Too many failed attempts. Please try again later.'
        });
    }

    if (!api_key) {
        return res.status(400).json({ error: 'API key required' });
    }

    if (!validateOmiApiKey(api_key)) {
        trackFailedKeyAttempt(uid);
        logAuditEvent('OMI_KEY_INVALID', uid, { ip: clientIp });
        return res.status(400).json({ error: 'Invalid API key format' });
    }

    try {
        // Test the API key first
        const testResponse = await fetch('https://api.omi.me/v3/memories?limit=1', {
            headers: {
                'Authorization': `Bearer ${api_key}`
            }
        });

        if (!testResponse.ok) {
            trackFailedKeyAttempt(uid);
            logAuditEvent('OMI_KEY_TEST_FAILED', uid, {
                ip: clientIp,
                status: testResponse.status
            });
            return res.status(400).json({ error: 'Invalid or unauthorized API key' });
        }

        // Clear failed attempts on success
        clearFailedKeyAttempts(uid);

        // If this is just a test, don't save the key
        if (test_only) {
            logAuditEvent('OMI_KEY_VALIDATION_PASSED', uid, { ip: clientIp });
            return res.json({ success: true, message: 'API key validation successful', validated_only: true });
        }

        // Encrypt the key
        const encryptedKey = encrypt(api_key);

        // Store in database
        const { error } = await supabase
            .from('user_settings')
            .upsert({
                uid: uid,
                omi_api_key_encrypted: encryptedKey,
                omi_enabled: true,
                key_added_at: new Date().toISOString()
            }, { onConflict: 'uid' });

        if (error) {
            console.error('Error saving OMI key:', error);
            return res.status(500).json({ error: 'Failed to save API key' });
        }

        logAuditEvent('OMI_KEY_ADDED', uid, { ip: clientIp });
        res.json({ success: true, message: 'OMI API key saved successfully' });
    } catch (error) {
        console.error('Error validating OMI key:', error);
        res.status(500).json({ error: 'Failed to validate API key' });
    }
});

// Delete OMI API key (with CSRF protection)
app.delete('/api/omi/key', security.validateUid, requireCsrf, async (req, res) => {
    const uid = req.uid;
    const clientIp = req.ip || req.connection.remoteAddress;
    
    try {
        const { error } = await supabase
            .from('user_settings')
            .update({
                omi_api_key_encrypted: null,
                omi_enabled: false,
                key_added_at: null,
                key_last_used: null
            })
            .eq('uid', uid);
        
        if (error) {
            console.error('Error deleting OMI key:', error);
            return res.status(500).json({ error: 'Failed to delete API key' });
        }
        
        logAuditEvent('OMI_KEY_REMOVED', uid, { ip: clientIp });
        res.json({ success: true, message: 'OMI API key removed successfully' });
    } catch (error) {
        console.error('Error deleting OMI key:', error);
        res.status(500).json({ error: 'Failed to delete API key' });
    }
});

// Toggle OMI integration on/off (with CSRF protection)
app.patch('/api/omi/toggle', security.validateUid, requireCsrf, async (req, res) => {
    const uid = req.uid;
    const { enabled } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;
    
    try {
        const { error } = await supabase
            .from('user_settings')
            .update({ omi_enabled: enabled })
            .eq('uid', uid);
        
        if (error) {
            console.error('Error toggling OMI:', error);
            return res.status(500).json({ error: 'Failed to update setting' });
        }
        
        logAuditEvent('OMI_TOGGLE', uid, { 
            ip: clientIp,
            enabled 
        });
        
        res.json({ success: true, omi_enabled: enabled });
    } catch (error) {
        console.error('Error toggling OMI:', error);
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// AI-powered Smart Actions endpoint
app.get('/api/smart-actions', security.validateUid, apiLimiter, async (req, res) => {
    const uid = req.uid; // Now sanitized

    try {
        // Get user's actions/goals
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const actions = userData?.goals || [];
        const pendingActions = actions.filter(a => !a.completed);
        
        // AI Analysis using OpenRouter
        const analysisPrompt = `Analyze these tasks and provide smart prioritization:
        ${JSON.stringify(pendingActions.map(a => a.text))}
        
        Return a JSON object with:
        1. high_priority: array of task indices that are urgent
        2. recurring_patterns: array of detected patterns
        3. suggestions: array of 2-3 actionable suggestions
        4. auto_categorization: object mapping task indices to categories`;

        let aiAnalysis = {
            high_priority: [],
            recurring_patterns: [],
            suggestions: [],
            auto_categorization: {}
        };

        if (process.env.OPENROUTER_API_KEY) {
            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'openai/gpt-4o-mini',
                        messages: [
                            { role: 'system', content: 'You are JARVIS, analyzing tasks with precision. Return only valid JSON with strategic insights.' },
                            { role: 'user', content: analysisPrompt }
                        ],
                        temperature: 0.3,
                        max_tokens: 500
                    })
                });

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;
                if (content) {
                    try {
                        aiAnalysis = JSON.parse(content);
                    } catch (e) {
                        console.error('Failed to parse AI response:', e);
                    }
                }
            } catch (err) {
                console.error('AI analysis error:', err);
            }
        }

        // Combine with basic pattern detection
        const highPriority = pendingActions.filter((a, idx) => 
            a.text.toLowerCase().includes('urgent') || 
            a.text.toLowerCase().includes('important') ||
            a.text.toLowerCase().includes('asap') ||
            aiAnalysis.high_priority.includes(idx)
        );

        const recurring = actions.filter(a => {
            const text = a.text.toLowerCase();
            return text.includes('daily') || text.includes('weekly') || text.includes('every');
        });

        res.json({
            actions,
            pending: pendingActions,
            high_priority: highPriority,
            recurring_patterns: [...recurring, ...aiAnalysis.recurring_patterns],
            suggestions: aiAnalysis.suggestions.length > 0 ? aiAnalysis.suggestions : [
                'Sir, I recommend reviewing and prioritizing your pending operations',
                'May I suggest establishing three strategic objectives for today',
                'Critical tasks require immediate scheduling, as you prefer'
            ],
            categorization: aiAnalysis.auto_categorization,
            stats: {
                total: actions.length,
                pending: pendingActions.length,
                completed: actions.filter(a => a.completed).length,
                today: actions.filter(a => 
                    new Date(a.created_at || a.created).toDateString() === new Date().toDateString()
                ).length
            }
        });
    } catch (err) {
        const error = security.handleDatabaseError(err, 'analyzing actions');
        res.status(error.status).json({ error: error.error });
    }
});

// AI-powered Insights endpoint
app.get('/api/insights', security.validateUid, apiLimiter, async (req, res) => {
    const uid = req.uid; // Now sanitized

    try {
        // Get user's actions and sessions
        const [userData, sessions] = await Promise.all([
            supabase.from('frienddb').select('goals').eq('uid', uid).single(),
            supabase.from('jarvis_sessions').select('*').eq('uid', uid).order('created_at', { ascending: false }).limit(50)
        ]);

        const actions = userData.data?.goals || [];
        
        // Pattern analysis
        const taskTypes = {};
        const weekdayActivity = {};
        const keywords = {};
        const hourlyActivity = {};
        
        actions.forEach(action => {
            // Type patterns
            const type = action.type || 'task';
            taskTypes[type] = (taskTypes[type] || 0) + 1;
            
            // Day patterns
            const date = new Date(action.created_at || action.created);
            const day = date.toLocaleDateString('en-US', { weekday: 'long' });
            weekdayActivity[day] = (weekdayActivity[day] || 0) + 1;
            
            // Hour patterns
            const hour = date.getHours();
            hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
            
            // Keyword extraction
            const words = action.text.toLowerCase().split(/\s+/);
            const importantWords = ['meeting', 'email', 'call', 'review', 'prepare', 'send', 'schedule', 'finish', 'create', 'update'];
            words.forEach(word => {
                if (importantWords.includes(word)) {
                    keywords[word] = (keywords[word] || 0) + 1;
                }
            });
        });

        // AI-powered insights
        let aiInsights = {
            patterns: [],
            recommendations: [],
            productivity_tips: []
        };

        if (process.env.OPENROUTER_API_KEY && actions.length > 5) {
            try {
                const insightPrompt = `Analyze this user's task patterns and provide insights:
                Top keywords: ${JSON.stringify(Object.entries(keywords).slice(0, 5))}
                Task types: ${JSON.stringify(taskTypes)}
                Busiest day: ${Object.entries(weekdayActivity).sort((a, b) => b[1] - a[1])[0]}
                
                Provide 3 patterns, 3 recommendations, and 2 productivity tips as JSON.`;

                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'openai/gpt-4o-mini',
                        messages: [
                            { role: 'system', content: 'You are JARVIS, providing strategic productivity insights. Analyze patterns like Tony Stark would. Return only valid JSON with patterns, recommendations, and productivity_tips arrays.' },
                            { role: 'user', content: insightPrompt }
                        ],
                        temperature: 0.5,
                        max_tokens: 400
                    })
                });

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;
                if (content) {
                    try {
                        aiInsights = JSON.parse(content);
                    } catch (e) {
                        console.error('Failed to parse AI insights:', e);
                    }
                }
            } catch (err) {
                console.error('AI insights error:', err);
            }
        }

        const topKeywords = Object.entries(keywords).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const busiestDay = Object.entries(weekdayActivity).sort((a, b) => b[1] - a[1])[0];
        const peakHour = Object.entries(hourlyActivity).sort((a, b) => b[1] - a[1])[0];

        res.json({
            patterns: {
                top_keywords: topKeywords,
                busiest_day: busiestDay,
                peak_hour: peakHour,
                task_types: taskTypes,
                ai_discovered: aiInsights.patterns
            },
            recommendations: aiInsights.recommendations.length > 0 ? aiInsights.recommendations : [
                busiestDay ? `Sir, your optimal performance occurs on ${busiestDay[0]}s. I suggest scheduling critical operations accordingly` : 'Shall I begin tracking your patterns for strategic optimization?',
                peakHour ? `Your cognitive peak is at ${peakHour[0]}:00 hours. Reserve this time for complex problem-solving` : 'I shall identify your peak performance windows, sir',
                'May I suggest creating automated protocols for your recurring operations?'
            ],
            productivity_tips: aiInsights.productivity_tips,
            stats: {
                total_actions: actions.length,
                total_sessions: sessions.data?.length || 0,
                completion_rate: Math.round((actions.filter(a => a.completed).length / (actions.length || 1)) * 100)
            }
        });
    } catch (err) {
        const error = security.handleDatabaseError(err, 'generating insights');
        res.status(error.status).json({ error: error.error });
    }
});

// Get user's analytics from both jarvis_sessions and frienddb
app.get('/api/analytics', security.validateUid, async (req, res) => {
    const uid = req.uid; // Use sanitized UID from middleware

    try {
        // Get sessions from jarvis_sessions
        const { data: sessions } = await supabase
            .from('jarvis_sessions')
            .select('*')
            .eq('uid', uid)
            .order('created_at', { ascending: false });

        // Get goals from frienddb
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const totalSessions = sessions?.length || 0;
        const totalMessages = sessions?.reduce((sum, s) => sum + (s.messages?.length || 0), 0) || 0;
        const lastActivity = sessions?.[0]?.last_activity;

        const analytics = {
            uid: uid,
            total_sessions: totalSessions,
            total_messages: totalMessages,
            total_actions: userData?.goals?.length || 0,
            last_activity: lastActivity,
            recent_sessions: sessions?.slice(0, 10) || []
        };

        res.json(analytics);
    } catch (err) {
        const error = security.handleDatabaseError(err, 'fetching analytics');
        res.status(error.status).json({ error: error.error });
    }
});

// Chat: get history
app.get('/api/chat/history', security.validateUid, async (req, res) => {
    try {
        const uid = req.uid; // Sanitized
        const sessionId = req.query.session_id;

        if (!sessionId) {
            // Return most recent CHAT-* session for this UID, if any
            const { data: sessions } = await supabase
                .from('jarvis_sessions')
                .select('*')
                .eq('uid', uid)
                .like('session_id', 'CHAT-%')
                .order('created_at', { ascending: false })
                .limit(1);

            const session = sessions?.[0];
            return res.json({
                session_id: session?.session_id || null,
                messages: session?.messages || []
            });
        }

        const session = await getOrCreateChatSession(sessionId, uid);
        return res.json({ session_id: session.session_id, messages: session.messages || [] });
    } catch (err) {
        console.error('Error fetching chat history:', err);
        // Graceful fallback so UI can still load
        return res.status(200).json({ session_id: null, messages: [] });
    }
});

// Chat: send message
app.post('/api/chat/message', security.validateUid, security.validateTextInput, apiLimiter, async (req, res) => {
    try {
        const uid = req.uid; // Sanitized
        const text = req.sanitizedText || req.body.text;
        const { session_id } = req.body || {};
        if (!text) return res.status(400).json({ error: 'Text is required' });

        const sessionId = session_id || newChatSessionId(uid);
        const session = await getOrCreateChatSession(sessionId, uid);

        const nowSec = Date.now() / 1000;
        const messages = Array.isArray(session.messages) ? [...session.messages] : [];

        // Append user message
        messages.push({
            text: String(text || '').trim(),
            timestamp: nowSec,
            is_user: true
        });

        // Generate assistant reply (with graceful fallback)
        let reply = 'Acknowledged.';
        try {
            reply = await generateAssistantReply(messages, uid);
        } catch (genErr) {
            console.error('Reply generation failed, using fallback:', genErr);
        }

        messages.push({
            text: reply,
            timestamp: nowSec + 0.1,
            is_user: false
        });

        // Persist (best-effort)
        try {
        const { error } = await supabase
            .from('jarvis_sessions')
            .update({
                uid,
                messages,
                last_activity: new Date().toISOString()
            })
            .eq('session_id', sessionId);
        if (error) throw error;
        } catch (persistErr) {
            console.error('Persist chat failed (non-fatal):', persistErr);
        }

        return res.json({ session_id: sessionId, messages });
    } catch (err) {
        console.error('Error sending chat message:', err);
        // Last-resort success response so UI continues to work
        const nowSec = Date.now() / 1000;
        const safeText = String(req.body?.text || '').trim();
        const messages = [
            { text: safeText, timestamp: nowSec, is_user: true },
            { text: 'Understood. Let\'s continue.', timestamp: nowSec + 0.1, is_user: false }
        ];
        return res.status(200).json({ session_id: req.body?.session_id || null, messages });
    }
});

// Save action to frienddb goals field (reusing Friend's structure)
app.post('/api/actions', security.validateUid, security.validateAction, async (req, res) => {
    const uid = req.uid; // Sanitized
    const { type, text } = req.validatedAction; // Validated
    const { date } = req.body;

    try {
        // Get existing goals from frienddb (row may not exist yet)
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const existingGoals = userData?.goals || [];
        const newGoal = {
            id: Date.now(),
            type: type || 'task',
            text: text,
            date: date,
            completed: false,
            created_at: new Date().toISOString()
        };

        // If user row doesn't exist yet, create it with the new goal
        if (!userData) {
            const { error: upsertError } = await supabase
                .from('frienddb')
                .upsert({ uid, goals: [newGoal] }, { onConflict: 'uid' });
            if (upsertError) throw upsertError;
            return res.json(newGoal);
        }

        // Add new goal to existing array
        const updatedGoals = [...existingGoals, newGoal];

        // Update frienddb with new goals
        const { error } = await supabase
            .from('frienddb')
            .update({ goals: updatedGoals })
            .eq('uid', uid);

        if (error) throw error;
        return res.json(newGoal);
    } catch (err) {
        console.error("Error saving action:", err);
        res.status(500).json({ error: "Failed to save action" });
    }
});

// Get user's actions from frienddb goals field
app.get('/api/actions', security.validateUid, async (req, res) => {
    const uid = req.uid; // Use sanitized UID from middleware

    try {
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const goals = userData?.goals || [];
        // Sort by created_at descending
        goals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        res.json(goals);
    } catch (err) {
        const error = security.handleDatabaseError(err, 'fetching actions');
        res.status(error.status).json({ error: error.error });
    }
});

// Update action in frienddb goals
app.put('/api/actions/:id', security.validateUid, async (req, res) => {
    const { id } = req.params;
    const uid = req.uid; // Use sanitized UID from middleware
    const { completed } = req.body;
    
    if (!id) {
        return res.status(400).json({ error: 'ID is required' });
    }

    try {
        // Get existing goals
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const goals = userData?.goals || [];
        const goalIndex = goals.findIndex(g => String(g.id) === String(id));
        
        if (goalIndex !== -1) {
            goals[goalIndex].completed = completed;
            goals[goalIndex].completed_at = completed ? new Date().toISOString() : null;
            
            // Update frienddb
            const { error } = await supabase
                .from('frienddb')
                .update({ goals: goals })
                .eq('uid', uid);
            if (error) throw error;
            
            res.json(goals[goalIndex]);
        } else {
            res.status(404).json({ error: 'Action not found' });
        }
    } catch (err) {
        const error = security.handleDatabaseError(err, 'updating action');
        res.status(error.status).json({ error: error.error });
    }
});

// Delete action from frienddb goals
app.delete('/api/actions/:id', security.validateUid, async (req, res) => {
    const { id } = req.params;
    const uid = req.uid; // Use sanitized UID from middleware
    
    if (!id) {
        return res.status(400).json({ error: 'ID is required' });
    }

    try {
        // Get existing goals
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const goals = userData?.goals || [];
        const filteredGoals = goals.filter(g => String(g.id) !== String(id));
        
        // Update frienddb
        const { error } = await supabase
            .from('frienddb')
            .update({ goals: filteredGoals })
            .eq('uid', uid);
        if (error) throw error;

        res.json({ success: true });
    } catch (err) {
        const error = security.handleDatabaseError(err, 'deleting action');
        res.status(error.status).json({ error: error.error });
    }
});

// Preferences helpers for salutation persistence
async function getSalutationForUid(uid) {
    try {
        const { data } = await supabase
            .from('frienddb')
            .select('analytics')
            .eq('uid', uid)
            .single();
        // JARVIS persona - default to "Sir" if no preference set
        return data?.analytics?.salutation || 'sir';
    } catch (err) {
        console.error("Error getting salutation:", err);
        return 'sir'; // JARVIS default
    }
}

async function setSalutationForUid(uid, salutation) {
    try {
        const s = String(salutation || '').toLowerCase();
        const { data } = await supabase
            .from('frienddb')
            .select('analytics')
            .eq('uid', uid)
            .single();
        
        const analytics = { ...(data?.analytics || {}), salutation: s };
        
        await supabase
            .from('frienddb')
            .upsert({ uid, analytics }, { onConflict: 'uid' });
        
        return s;
    } catch (err) {
        console.error("Error setting salutation:", err);
        return null;
    }
}

// GET /api/preferences?uid=...
app.get('/api/preferences', security.validateUid, async (req, res) => {
    try {
        const uid = req.uid; // Use sanitized UID from middleware
        const salutation = await getSalutationForUid(uid);
        res.json({ salutation });
    } catch (err) {
        const error = security.handleDatabaseError(err, 'loading preferences');
        res.status(error.status).json({ error: error.error });
    }
});

// POST /api/preferences { uid, salutation }
app.post('/api/preferences', security.validateUid, async (req, res) => {
    try {
        const uid = req.uid; // Use sanitized UID from middleware
        const { salutation } = req.body || {};
        if (!salutation) {
            return res.status(400).json({ error: 'Salutation is required' });
        }
        const saved = await setSalutationForUid(uid, salutation);
        res.json({ salutation: saved });
    } catch (err) {
        const error = security.handleDatabaseError(err, 'saving preferences');
        res.status(error.status).json({ error: error.error });
    }
});

// Tool definitions for function-calling capable backends (schema only)
const TOOL_CALLING_ENABLED = String(process.env.TOOL_CALLING_ENABLED || 'false').toLowerCase() === 'true';
const jarvisTools = TOOL_CALLING_ENABLED ? [
    {
        type: 'function',
        function: {
            name: 'add_action',
            description: 'Create an action (task, reminder, event, note) for the current user',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['task', 'reminder', 'event', 'note'] },
                    text: { type: 'string' },
                    date: { type: 'string', description: 'ISO datetime, optional' }
                },
                required: ['type', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_actions',
            description: 'List actions for the current user',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_analytics',
            description: 'Get analytics summary for the current user',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_preferences',
            description: 'Get user preference values such as salutation',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
    }
] : undefined;

// Helper to attach tool schemas if enabled
function maybeAttachTools(payload) {
    if (TOOL_CALLING_ENABLED && jarvisTools) {
        return { ...payload, tools: jarvisTools };
    }
    return payload;
}

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`JARVIS server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Validation warnings
    const warnings = [];
    
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        warnings.push('⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY not set - using anon key (less secure)');
    }
    
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === 'jarvis-secure-key-2024-change-this-in-production') {
        warnings.push('⚠️  CRITICAL: Using default ENCRYPTION_KEY - change in production!');
    }
    
    if (!process.env.OPENROUTER_API_KEY) {
        warnings.push('⚠️  WARNING: OPENROUTER_API_KEY not set - AI features disabled');
    }
    
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
        warnings.push('⚠️  CRITICAL: Supabase configuration missing - app will not work properly');
    }
    
    if (process.env.NODE_ENV === 'production') {
        if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
            warnings.push('🔴 CRITICAL: Production requires a strong ENCRYPTION_KEY (32+ characters)');
        }
        
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
            warnings.push('🔴 CRITICAL: Production requires SUPABASE_SERVICE_ROLE_KEY for security');
        }
    }
    
    // Print warnings
    if (warnings.length > 0) {
        console.log('\n=== CONFIGURATION WARNINGS ===');
        warnings.forEach(warning => console.log(warning));
        console.log('===============================\n');
        
        if (process.env.NODE_ENV === 'production' && warnings.some(w => w.includes('CRITICAL'))) {
            console.log('🔴 PRODUCTION SAFETY: Critical security issues detected!');
            console.log('   Please review .env.production for required settings.\n');
        }
    } else {
        console.log('✅ All security configurations validated successfully');
    }
    
    console.log(`📡 JARVIS system online at http://localhost:${port}`);
});

module.exports = app;
