/*
 * Security improvements from Brain app analysis
 * Apply these patterns to JARVIS without breaking functionality
 */

// 1. Input Validation Middleware (from Brain)
function validateUid(req, res, next) {
    const uid = req.body.uid || req.query.uid || req.params.uid;
    if (!uid || typeof uid !== 'string' || uid.length < 3 || uid.length > 50) {
        return res.status(400).json({ error: 'Invalid user ID format' });
    }
    // Sanitize UID - remove any non-alphanumeric characters
    req.uid = uid.replace(/[^a-zA-Z0-9-_]/g, '');
    next();
}

// 2. Text Input Validation (from Brain)
function validateTextInput(req, res, next) {
    const { text, message } = req.body;
    const input = text || message;
    
    if (input && typeof input === 'string') {
        // Remove potentially harmful characters
        req.sanitizedText = input
            .replace(/[<>]/g, '') // Remove HTML tags
            .trim()
            .substring(0, 5000); // Limit length
    }
    next();
}

// 3. Generic Error Handler (from Brain)
function handleDatabaseError(error, operation) {
    console.error(`Database error during ${operation}:`, error);
    return {
        status: 500,
        error: 'A database error occurred. Please try again later.'
    };
}

// 4. Safe Text Processing
function sanitizeUserInput(text) {
    if (!text || typeof text !== 'string') return '';
    
    return text
        .replace(/[<>]/g, '') // Remove HTML brackets
        .replace(/['"]/g, '') // Remove quotes that could break SQL
        .trim()
        .substring(0, 5000); // Limit length
}

// 5. Session-based Auth (optional upgrade from UID-only)
function requireAuth(req, res, next) {
    const uid = req.uid || req.session?.userId;
    
    if (!uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    req.authenticatedUid = uid;
    next();
}

// 6. Request Size Limits (add to main app)
// app.use(bodyParser.json({ limit: '10mb' }));
// app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// 7. Validation for Actions/Goals
function validateAction(req, res, next) {
    const { type, text } = req.body;
    
    if (!text || typeof text !== 'string' || text.length > 500) {
        return res.status(400).json({ error: 'Invalid action text' });
    }
    
    const validTypes = ['task', 'reminder', 'goal', 'event', 'note'];
    if (type && !validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid action type' });
    }
    
    req.validatedAction = {
        type: type || 'task',
        text: sanitizeUserInput(text)
    };
    next();
}

module.exports = {
    validateUid,
    validateTextInput,
    handleDatabaseError,
    sanitizeUserInput,
    requireAuth,
    validateAction
};

/* 
 * HOW TO APPLY TO JARVIS (without breaking):
 * 
 * 1. Import this file in index.js:
 *    const security = require('./security-improvements');
 * 
 * 2. Add to endpoints gradually:
 *    app.get('/api/smart-actions', security.validateUid, apiLimiter, async (req, res) => {
 *        const uid = req.uid; // Now sanitized
 *    });
 * 
 * 3. Replace error messages:
 *    catch (err) {
 *        const error = security.handleDatabaseError(err, 'fetching actions');
 *        res.status(error.status).json({ error: error.error });
 *    }
 * 
 * 4. Sanitize user inputs:
 *    const cleanText = security.sanitizeUserInput(req.body.text);
 * 
 * This way you can gradually improve security without breaking anything!
 */