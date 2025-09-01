// Enhanced Jarvis with UID support to connect OMI data to UI

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: '../.env' });
const app = express();

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// CRITICAL: Serve HTML with UID awareness
app.get('/', (req, res) => {
    // If no UID, show enter UID page (like Friend app)
    if (!req.query.uid) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>J.A.R.V.I.S. - Enter UID</title>
                <style>
                    body {
                        background: #000;
                        color: #00d4ff;
                        font-family: 'Orbitron', monospace;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                    }
                    .uid-form {
                        background: rgba(0, 30, 60, 0.9);
                        padding: 40px;
                        border-radius: 20px;
                        border: 1px solid #00d4ff;
                        text-align: center;
                    }
                    input {
                        background: rgba(0, 50, 100, 0.5);
                        border: 1px solid #00d4ff;
                        color: #00d4ff;
                        padding: 10px;
                        margin: 10px;
                        border-radius: 5px;
                    }
                    button {
                        background: rgba(0, 100, 150, 0.5);
                        border: 1px solid #00d4ff;
                        color: #00d4ff;
                        padding: 10px 20px;
                        cursor: pointer;
                        border-radius: 5px;
                    }
                </style>
            </head>
            <body>
                <div class="uid-form">
                    <h1>J.A.R.V.I.S.</h1>
                    <p>Enter your OMI UID to continue</p>
                    <form action="/" method="GET">
                        <input type="text" name="uid" placeholder="Your UID" required>
                        <br>
                        <button type="submit">ACCESS SYSTEM</button>
                    </form>
                </div>
            </body>
            </html>
        `);
    }
    
    // With UID, serve the control panel
    res.sendFile(path.join(__dirname, 'jarvis-control-panel.html'));
});

// NEW API ENDPOINTS to connect UI to OMI data

// Get user's transcripts from OMI webhook data
app.get('/api/transcripts', async (req, res) => {
    const uid = req.query.uid;
    if (!uid) {
        return res.status(400).json({ error: 'UID required' });
    }

    try {
        // Get sessions for this UID
        const { data: sessions } = await supabase
            .from('jarvis_sessions')
            .select('*')
            .eq('uid', uid)  // Need to add UID column to table!
            .order('created_at', { ascending: false })
            .limit(50);

        // Format transcripts from sessions
        const transcripts = sessions?.map(session => ({
            text: session.messages?.map(m => m.text).join(' '),
            created: session.created_at,
            session_id: session.session_id
        })) || [];

        res.json(transcripts);
    } catch (err) {
        console.error("Error fetching transcripts:", err);
        res.status(500).json({ error: "Failed to fetch transcripts" });
    }
});

// Get user's actions/analytics
app.get('/api/actions', async (req, res) => {
    const uid = req.query.uid;
    if (!uid) {
        return res.status(400).json({ error: 'UID required' });
    }

    try {
        // Get user-specific actions
        const { data: actions } = await supabase
            .from('jarvis_actions')  // New table needed
            .select('*')
            .eq('uid', uid)
            .order('created_at', { ascending: false });

        res.json(actions || []);
    } catch (err) {
        console.error("Error fetching actions:", err);
        res.status(500).json({ error: "Failed to fetch actions" });
    }
});

// Save action from UI
app.post('/api/actions', async (req, res) => {
    const { uid, type, text, date } = req.body;
    
    if (!uid || !text) {
        return res.status(400).json({ error: 'UID and text required' });
    }

    try {
        const { data, error } = await supabase
            .from('jarvis_actions')
            .insert([{
                uid: uid,
                type: type || 'task',
                text: text,
                date: date,
                completed: false,
                created_at: new Date()
            }])
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("Error saving action:", err);
        res.status(500).json({ error: "Failed to save action" });
    }
});

// ENHANCED WEBHOOK - Now stores UID with sessions
app.post('/webhook', async (req, res) => {
    const data = req.body;
    const sessionId = data.session_id;
    const uid = data.uid;  // OMI sends UID in webhook!
    const segments = data.segments || [];

    if (!sessionId) {
        console.error('No session_id provided');
        return res.status(400).json({ message: 'No session_id provided' });
    }

    // Store UID with session for later retrieval
    try {
        await supabase
            .from('jarvis_sessions')
            .upsert({
                session_id: sessionId,
                uid: uid,  // Now we can link sessions to users!
                messages: segments,
                last_activity: new Date(),
                created_at: new Date()
            });
    } catch (err) {
        console.error("Error storing session:", err);
    }

    // Rest of webhook processing...
    // [Original webhook code continues here]
    
    return res.status(200).json({});
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Jarvis with UID support at http://localhost:${port}`);
});