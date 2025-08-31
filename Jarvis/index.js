const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config();
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Security middleware
app.disable('x-powered-by');
app.use(helmet({ 
    contentSecurityPolicy: false  // Disabled to keep inline scripts working
}));

// Rate limiting - generous limits to avoid breaking functionality
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    message: 'Too many requests, please try again later.'
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);

// Middleware to parse JSON bodies
app.use(express.json());

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
    
    // Use OpenRouter as fallback
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
                    model: 'openai/gpt-oss-120b:free',  // Using the requested 120B model
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
                return data.choices?.[0]?.message?.content || `As you wish, ${salutation}.`;
            }
        } catch (err) {
            console.error('OpenRouter error:', err);
        }
    }
    
    // Fallback to simple responses
    const responses = [
        `Certainly, ${salutation}. I'll help you with that.`,
        `Right away, ${salutation}.`,
        `As you wish, ${salutation}.`,
        `Of course, ${salutation}. Consider it done.`,
        `I understand, ${salutation}. Let me assist you with that.`
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
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

// Get user's transcripts from jarvis_sessions
app.get('/api/transcripts', async (req, res) => {
    const uid = req.query.uid;
    
    if (!uid) {
        return res.status(400).json({ error: 'UID is required' });
    }

    try {
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
            session_id: session.session_id
        }));

        res.json(transcripts);
    } catch (err) {
        console.error("Error fetching transcripts:", err);
        res.status(500).json({ error: "Failed to fetch transcripts" });
    }
});

// Get user's analytics from both jarvis_sessions and frienddb
app.get('/api/analytics', async (req, res) => {
    const uid = req.query.uid;
    
    if (!uid) {
        return res.status(400).json({ error: 'UID is required' });
    }

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
        console.error("Error getting analytics:", err);
        res.status(500).json({ error: "Failed to get analytics" });
    }
});

// Chat: get history
app.get('/api/chat/history', async (req, res) => {
    try {
        const uid = req.query.uid;
        const sessionId = req.query.session_id;
        if (!uid) return res.status(400).json({ error: 'UID is required' });

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
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

// Chat: send message
app.post('/api/chat/message', async (req, res) => {
    try {
        const { uid, session_id, text } = req.body || {};
        if (!uid || !text) return res.status(400).json({ error: 'UID and text are required' });

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

        // Generate assistant reply
        const reply = await generateAssistantReply(messages, uid);

        messages.push({
            text: reply,
            timestamp: nowSec + 0.1,
            is_user: false
        });

        // Persist
        const { error } = await supabase
            .from('jarvis_sessions')
            .update({
                uid,
                messages,
                last_activity: new Date().toISOString()
            })
            .eq('session_id', sessionId);

        if (error) throw error;

        return res.json({ session_id: sessionId, messages });
    } catch (err) {
        console.error('Error sending chat message:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Save action to frienddb goals field (reusing Friend's structure)
app.post('/api/actions', async (req, res) => {
    const { uid, type, text, date } = req.body;
    
    if (!uid || !text) {
        return res.status(400).json({ error: 'UID and text are required' });
    }

    try {
        // Get existing goals from frienddb
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

        // Add new goal to array
        const updatedGoals = [...existingGoals, newGoal];

        // Update frienddb with new goals
        const { error } = await supabase
            .from('frienddb')
            .update({ goals: updatedGoals })
            .eq('uid', uid);

        if (error) throw error;
        res.json(newGoal);
    } catch (err) {
        console.error("Error saving action:", err);
        res.status(500).json({ error: "Failed to save action" });
    }
});

// Get user's actions from frienddb goals field
app.get('/api/actions', async (req, res) => {
    const uid = req.query.uid;
    
    if (!uid) {
        return res.status(400).json({ error: 'UID is required' });
    }

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
        console.error("Error fetching actions:", err);
        res.json([]);
    }
});

// Update action in frienddb goals
app.put('/api/actions/:id', async (req, res) => {
    const { id } = req.params;
    const { uid, completed } = req.body;
    
    if (!uid || !id) {
        return res.status(400).json({ error: 'UID and ID are required' });
    }

    try {
        // Get existing goals
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const goals = userData?.goals || [];
        const goalIndex = goals.findIndex(g => g.id == id);
        
        if (goalIndex !== -1) {
            goals[goalIndex].completed = completed;
            goals[goalIndex].completed_at = completed ? new Date().toISOString() : null;
            
            // Update frienddb
            await supabase
                .from('frienddb')
                .update({ goals: goals })
                .eq('uid', uid);
            
            res.json(goals[goalIndex]);
        } else {
            res.status(404).json({ error: 'Action not found' });
        }
    } catch (err) {
        console.error("Error updating action:", err);
        res.status(500).json({ error: "Failed to update action" });
    }
});

// Delete action from frienddb goals
app.delete('/api/actions/:id', async (req, res) => {
    const { id } = req.params;
    const uid = req.query.uid;
    
    if (!uid || !id) {
        return res.status(400).json({ error: 'UID and ID are required' });
    }

    try {
        // Get existing goals
        const { data: userData } = await supabase
            .from('frienddb')
            .select('goals')
            .eq('uid', uid)
            .single();

        const goals = userData?.goals || [];
        const filteredGoals = goals.filter(g => g.id != id);
        
        // Update frienddb
        await supabase
            .from('frienddb')
            .update({ goals: filteredGoals })
            .eq('uid', uid);

        res.json({ success: true });
    } catch (err) {
        console.error("Error deleting action:", err);
        res.status(500).json({ error: "Failed to delete action" });
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
app.get('/api/preferences', async (req, res) => {
    try {
        const uid = req.query.uid;
        if (!uid) {
            return res.status(400).json({ error: 'UID is required' });
        }
        const salutation = await getSalutationForUid(uid);
        res.json({ salutation });
    } catch (err) {
        console.error("Error in GET preferences:", err);
        res.status(500).json({ error: 'Failed to load preferences' });
    }
});

// POST /api/preferences { uid, salutation }
app.post('/api/preferences', async (req, res) => {
    try {
        const { uid, salutation } = req.body || {};
        if (!uid || !salutation) {
            return res.status(400).json({ error: 'UID and salutation are required' });
        }
        const saved = await setSalutationForUid(uid, salutation);
        res.json({ salutation: saved });
    } catch (err) {
        console.error("Error in POST preferences:", err);
        res.status(500).json({ error: 'Failed to save preferences' });
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
    console.log(`Jarvis app listening at http://localhost:${port}`);
});

module.exports = app;
