const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config();
const app = express();

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

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

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Jarvis app listening at http://localhost:${port}`);
});

module.exports = app;
