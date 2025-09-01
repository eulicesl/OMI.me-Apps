const express = require('express');
const path = require('path');
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files (for CSS, JS if needed)
app.use(express.static(path.join(__dirname)));

// Serve the control panel HTML at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'jarvis-control-panel.html'));
});

// Mock webhook endpoint for testing
app.post('/webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    return res.status(200).json({ message: 'Webhook received' });
});

// Mock status endpoint
app.get('/status', (req, res) => {
    return res.status(200).json({
        active_sessions: 0,
        database_sessions: 0,
        uptime: process.uptime(),
    });
});

// Mock analytics endpoint
app.get('/analytics', (req, res) => {
    return res.status(200).json({
        session_id: req.query.session_id || 'test',
        total_messages: 0,
        user_messages: 0,
        system_messages: 0,
        last_activity: new Date().toISOString(),
        created_at: new Date().toISOString()
    });
});

// Mock setup status endpoint
app.get('/webhook/setup-status', (req, res) => {
    return res.status(200).json({ is_setup_completed: true });
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Jarvis control panel available at http://localhost:${port}`);
    console.log(`Open your browser to view the J.A.R.V.I.S. interface`);
});