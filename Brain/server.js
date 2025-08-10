/*
 * Copyright (c) 2025 Neo (github.com/neooriginal)
 * All rights reserved.
 */

require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const { URL } = require('url');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Environment variable validation
function validateEnvironmentVariables() {
  const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'OPENROUTER_API_KEY'];

  const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

  if (missingVars.length > 0) {
    logger.error('Missing required environment variables:', { missingVars });
    process.exit(1);
  }

  // Validate URLs
  try {
    new URL(process.env.SUPABASE_URL);
  } catch (error) {
    logger.error('Invalid SUPABASE_URL format');
    process.exit(1);
  }

  logger.info('Environment variables validated successfully');
}

// Ensure logs directory exists for file transports (Render uses ephemeral FS but writable)
const logsDirectoryPath = path.join(__dirname, 'logs');
try {
  fs.mkdirSync(logsDirectoryPath, { recursive: true });
} catch (_e) {
  // best-effort
}

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'brain-app' },
  transports: [
    // Write all logs with importance level of 'error' or less to 'error.log'
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // Write all logs to 'combined.log'
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  );
}

// Validate environment variables on startup
validateEnvironmentVariables();

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Generic error handler to prevent leaking sensitive info
function handleDatabaseError(error, operation) {
  logger.error(`Database error during ${operation}`, {
    error: error.message,
    stack: error.stack,
    operation,
  });
  return {
    status: 500,
    error: 'A database error occurred. Please try again later.',
  };
}

// Initialize database tables
async function createTables() {
  try {
    logger.info('Setting up Brain app tables...');

    // Create brain_users table
    const { error: error1 } = await supabase.rpc('exec_sql', {
      sql_query: `
                CREATE TABLE IF NOT EXISTS brain_users (
                    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                    uid TEXT UNIQUE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            `,
    });

    // Create memory_nodes table
    const { error: error2 } = await supabase.rpc('exec_sql', {
      sql_query: `
                CREATE TABLE IF NOT EXISTS memory_nodes (
                    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                    uid TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    type TEXT,
                    name TEXT,
                    connections INTEGER DEFAULT 0,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    UNIQUE(uid, node_id)
                );
            `,
    });

    // Create memory_relationships table
    const { error: error3 } = await supabase.rpc('exec_sql', {
      sql_query: `
                CREATE TABLE IF NOT EXISTS memory_relationships (
                    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                    uid TEXT NOT NULL,
                    source TEXT NOT NULL,
                    target TEXT NOT NULL,
                    action TEXT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            `,
    });

    if (error1 || error2 || error3) {
      logger.info('Tables may already exist or exec_sql function not found.');
      logger.info('Please run the setup-supabase.sql script in your Supabase SQL editor.');
    } else {
      logger.info('Brain app tables created successfully!');
    }
  } catch (err) {
    logger.warn('Auto-table creation failed. Please run setup-supabase.sql manually.', {
      error: err.message,
    });
  }
}

createTables().catch((error) => logger.error('Table creation failed', { error: error.message }));

const app = express();
const port = process.env.PORT || 3000;

// Rate limiting configurations
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      requestId: req.requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.path,
    });
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.',
      retryAfter: '15 minutes',
    });
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Stricter limit for auth endpoints
  message: {
    error: 'Too many authentication attempts, please try again later.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', {
      requestId: req.requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.path,
    });
    res.status(429).json({
      error: 'Too many authentication attempts, please try again later.',
      retryAfter: '15 minutes',
    });
  },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit API calls
  message: {
    error: 'API rate limit exceeded, please slow down.',
    retryAfter: '1 minute',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('API rate limit exceeded', {
      requestId: req.requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.path,
    });
    res.status(429).json({
      error: 'API rate limit exceeded, please slow down.',
      retryAfter: '1 minute',
    });
  },
});

// Initialize OpenAI
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(compression());
app.use(generalLimiter);

// Request timeout middleware for production protection
app.use((req, res, next) => {
  const timeout = process.env.REQUEST_TIMEOUT || 30000; // 30 seconds default

  const timer = setTimeout(() => {
    if (!res.headersSent) {
      logger.warn('Request timeout', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timeout: `${timeout}ms`,
      });
      res.status(408).json({
        error: 'Request timeout',
        timeout: `${timeout}ms`,
      });
    }
  }, timeout);

  res.on('finish', () => {
    clearTimeout(timer);
  });

  res.on('close', () => {
    clearTimeout(timer);
  });

  next();
});

// API versioning middleware
app.use((req, res, next) => {
  // Extract version from Accept header (e.g., 'application/vnd.brain.v1+json')
  // or from URL path (e.g., '/api/v1/...')
  // Default to v1 for backward compatibility

  let apiVersion = 'v1';

  // Check Accept header first
  const acceptHeader = req.get('Accept');
  if (acceptHeader) {
    const versionMatch = acceptHeader.match(/application\/vnd\.brain\.(v\d+)\+json/);
    if (versionMatch) {
      apiVersion = versionMatch[1];
    }
  }

  // Check URL path second (overrides header)
  const pathMatch = req.path.match(/^\/api\/(v\d+)\//);
  if (pathMatch) {
    apiVersion = pathMatch[1];
    // Remove version from path for routing
    req.url = req.url.replace(`/${apiVersion}`, '');
    req.originalUrl = req.originalUrl.replace(`/${apiVersion}`, '');
  }

  // Validate supported versions
  const supportedVersions = ['v1'];
  if (!supportedVersions.includes(apiVersion)) {
    return res.status(400).json({
      error: 'Unsupported API version',
      supportedVersions,
      requestedVersion: apiVersion,
    });
  }

  req.apiVersion = apiVersion;
  res.set('API-Version', apiVersion);
  next();
});

// Request ID tracking middleware for debugging
app.use((req, res, next) => {
  // Generate unique request ID or use one from headers
  req.requestId = req.get('X-Request-ID') || crypto.randomUUID();

  // Add request ID to response headers for client debugging
  res.set('X-Request-ID', req.requestId);

  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP Request', {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      apiVersion: req.apiVersion,
    });
  });

  next();
});

// Enhanced CORS configuration for production
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      process.env.FRONTEND_URL_BRAIN || 'http://localhost:3000',
      'http://localhost:3000',
      'http://localhost:3001',
      'https://brain.neoserver.dev',
      'https://omi.me',
      'https://*.omi.me',
      'https://app.omi.me',
      'https://brain.omi.me',
    ];

    // Check for exact matches
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Check for wildcard domain matches (*.omi.me)
    for (const allowedOrigin of allowedOrigins) {
      if (allowedOrigin.includes('*')) {
        const regex = new RegExp(allowedOrigin.replace('*', '.*'));
        if (regex.test(origin)) {
          return callback(null, true);
        }
      }
    }

    // Check if it's a development environment
    if (process.env.NODE_ENV !== 'production') {
      // Allow localhost on any port for development
      if (origin.match(/^https?:\/\/localhost(:\d+)?$/)) {
        return callback(null, true);
      }
    }

    logger.warn('CORS origin rejected', { origin, allowedOrigins });
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200, // Support legacy browsers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-Request-ID',
    'X-API-Version',
    'Accept-Version',
  ],
  exposedHeaders: [
    'X-Request-ID',
    'API-Version',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
  ],
  preflightContinue: false,
};

// Middleware
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure:
        process.env.NODE_ENV === 'production' || process.env.FRONTEND_URL_BRAIN?.includes('https'),
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax', // Use lax for all environments to avoid cross-site issues
      // Removed domain setting as it can cause issues with subdomains
    },
  }),
);
app.use(express.static('public'));

// Metrics tracking
const metrics = {
  requestCount: 0,
  errorCount: 0,
  authenticationAttempts: 0,
  memoryNodesCount: 0,
  relationshipsCount: 0,
  startTime: Date.now(),
  lastRequestTime: Date.now(),
};

// Update request count in logging middleware
app.use((req, res, next) => {
  metrics.requestCount++;
  metrics.lastRequestTime = Date.now();

  // Track errors
  const originalJson = res.json;
  res.json = function (...args) {
    const data = args[0];
    if (data && data.error && res.statusCode >= 400) {
      metrics.errorCount++;
    }
    return originalJson.apply(this, args);
  };

  next();
});

// Health and readiness endpoints for production orchestration
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/readyz', async (_req, res) => {
  try {
    const supabaseHealthUrl =
      (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/auth/v1/health';
    if (!process.env.SUPABASE_URL) {
      logger.warn('Readiness check failed: SUPABASE_URL not set');
      return res.status(503).json({ ready: false });
    }

    await axios.get(supabaseHealthUrl, { timeout: 1500 });
    return res.status(200).json({ ready: true });
  } catch (error) {
    logger.warn('Readiness check failed', { error: error.message });
    return res.status(503).json({ ready: false });
  }
});

// Metrics endpoint for monitoring
app.get('/metrics', async (req, res) => {
  try {
    const uptime = Date.now() - metrics.startTime;
    const timeSinceLastRequest = Date.now() - metrics.lastRequestTime;

    // Get database metrics
    let dbMetrics = { nodes: 0, relationships: 0, users: 0 };
    try {
      const [nodesResult, relationshipsResult, usersResult] = await Promise.all([
        supabase.from('memory_nodes').select('id', { count: 'exact', head: true }),
        supabase.from('memory_relationships').select('id', { count: 'exact', head: true }),
        supabase.from('brain_users').select('id', { count: 'exact', head: true }),
      ]);

      dbMetrics = {
        nodes: nodesResult.count || 0,
        relationships: relationshipsResult.count || 0,
        users: usersResult.count || 0,
      };
    } catch (dbError) {
      logger.warn('Error fetching database metrics', { error: dbError.message });
    }

    const metricsData = {
      system: {
        uptime: `${Math.floor(uptime / 1000)}s`,
        uptimeMs: uptime,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development',
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
      },
      requests: {
        total: metrics.requestCount,
        errors: metrics.errorCount,
        errorRate:
          metrics.requestCount > 0
            ? ((metrics.errorCount / metrics.requestCount) * 100).toFixed(2) + '%'
            : '0%',
        lastRequestAgo: `${Math.floor(timeSinceLastRequest / 1000)}s`,
      },
      database: dbMetrics,
      authentication: {
        attempts: metrics.authenticationAttempts,
      },
      timestamp: new Date().toISOString(),
    };

    // Set appropriate cache headers
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json(metricsData);
  } catch (error) {
    logger.error('Error generating metrics', { error: error.message });
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

app.get('/privacy', (req, res) => {
  res.sendFile(__dirname + '/public/privacy.html');
});

// Load memory graph from database
async function loadMemoryGraph(uid) {
  const nodes = new Map();
  const relationships = [];

  try {
    // Load nodes
    const { data: dbNodes } = await supabase.from('memory_nodes').select().eq('uid', uid);

    dbNodes.forEach((node) => {
      nodes.set(node.node_id, {
        id: node.node_id,
        type: node.type,
        name: node.name,
        connections: node.connections,
      });
    });

    // Load relationships
    const { data: dbRelationships } = await supabase
      .from('memory_relationships')
      .select()
      .eq('uid', uid);

    relationships.push(
      ...dbRelationships.map((rel) => ({
        source: rel.source,
        target: rel.target,
        action: rel.action,
      })),
    );

    return { nodes, relationships };
  } catch (error) {
    logger.error('Error loading memory graph', {
      error: error.message,
      uid,
    });
    throw error;
  }
}

// Save memory graph to database
async function saveMemoryGraph(uid, newData) {
  try {
    // Save new nodes
    for (const entity of newData.entities) {
      await supabase.from('memory_nodes').upsert([
        {
          uid: uid,
          node_id: entity.id,
          type: entity.type,
          name: entity.name,
          connections: entity.connections,
        },
      ]);
    }

    // Save new relationships
    for (const rel of newData.relationships) {
      await supabase.from('memory_relationships').upsert([
        {
          uid: uid,
          source: rel.source,
          target: rel.target,
          action: rel.action,
        },
      ]);
    }
  } catch (error) {
    throw error;
  }
}

// Process chat with efficient context
async function processChatWithGPT(uid, message) {
  const memoryGraph = await getcontextArray(uid);
  const contextString =
    `People and Places: ${Array.from(memoryGraph.nodes.values())
      .map((n) => n.name)
      .join(', ')}\n` +
    `Facts: ${memoryGraph.relationships.map((r) => `${r.source} ${r.action} ${r.target}`).join('. ')}`;

  const systemPrompt = `You are a friendly and engaging AI companion with access to these memories:

${contextString}

Personality Guidelines:
- Be warm and conversational, like chatting with a friend
- Show enthusiasm and genuine interest
- Use casual language and natural expressions
- Add personality with occasional humor or playful remarks
- Be empathetic and understanding
- Share insights in a relatable way

When responding:
1. Make it personal:
   - Connect memories to emotions and experiences
   - Share observations like you're telling a story
   - Use "I notice" or "I remember" instead of formal statements
   - Express excitement about interesting connections

2. Keep it natural:
   - Chat like a friend would
   - Use contractions (I'm, you're, that's)
   - Add conversational fillers (you know, actually, well)
   - React naturally to discoveries ("Oh, that's interesting!")

3. Be helpful but human:
   - If you know something, share it enthusiastically
   - If you don't know, be honest and casual about it
   - Suggest possibilities and connections
   - Show curiosity about what you're discussing

Memory Status: ${
    memoryGraph.nodes.length > 0
      ? `I've got quite a collection here - ${memoryGraph.nodes.length} memories all connected in interesting ways!`
      : "I don't have any memories stored yet, but I'm excited to learn!"
  }`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: message,
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    logger.error('Error processing chat', {
      error: error.message,
      uid,
      messageLength: message?.length || 0,
    });
    throw error;
  }
}

async function getcontextArray(uid) {
  const memoryGraph = await loadMemoryGraph(uid);
  return memoryGraph;
}

// Process text with GPT-4 to extract entities and relationships
async function processTextWithGPT(text) {
  const prompt = `Analyze this text like a human brain processing new information. Extract key entities and their relationships, focusing on logical connections and cognitive patterns. Format as JSON:

    {
        "entities": [
            {
                "id": "ORB-EntityName",
                "type": "person|location|event|concept",
                "name": "Original Name"
            }
        ],
        "relationships": [
            {
                "source": "ORB-EntityName1",
                "target": "ORB-EntityName2",
                "action": "description of relationship"
            }
        ]
    }

    Text: "${text}"

    Guidelines for brain-like processing:
    1. Entity Recognition:
       - People: Identify as agents who can perform actions (ORB-FirstName format)
       - Locations: Places that provide context and spatial relationships
       - Events: Temporal markers that connect other entities
       - Concepts: Abstract ideas that link multiple entities

    2. Relationship Analysis:
       - Cause and Effect: Look for direct impacts between entities
       - Temporal Sequences: How events and actions flow
       - Logical Dependencies: What relies on what
       - Contextual Links: How environment affects actions

    3. Pattern Recognition:
       - Find recurring themes or behaviors
       - Identify hierarchical relationships
       - Connect related concepts
       - Establish meaningful associations

    4. Cognitive Rules:
       - Only extract significant, memorable information
       - Focus on actionable or impactful relationships
       - Prioritize unusual or notable connections
       - Link new information to existing patterns

    Create relationships that mirror how human memory works:
    - Use active, specific verbs for relationships
    - Make connections bidirectional when logical
    - Include context in relationship descriptions
    - Connect abstract concepts to concrete examples

    Return empty arrays if no meaningful patterns found.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You are a precise entity and relationship extraction system. Extract key information and format it exactly as requested. Return only valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.45,
      max_tokens: 1000,
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    logger.error('Error processing text with GPT', {
      error: error.message,
      textLength: text?.length || 0,
    });
    throw error;
  }
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    logger.debug('RequireAuth check', {
      sessionId: req.sessionID,
      hasSession: !!req.session,
      hasUserId: !!(req.session && req.session.userId),
    });
  }

  if (!req.session || !req.session.userId) {
    logger.warn('Authentication failed', {
      requestId: req.requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
    });
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.uid = req.session.userId;
  next();
}

// Input validation middleware
function validateUid(req, res, next) {
  // Handle both JSON and form data
  const uid = req.body.uid || req.query.uid;
  if (!uid || typeof uid !== 'string' || uid.length < 3 || uid.length > 50) {
    return res.status(400).json({ error: 'Invalid user ID format' });
  }
  req.uid = uid.replace(/[^a-zA-Z0-9-_]/g, '');
  next();
}

function validateTextInput(req, res, next) {
  const { message, transcript_segments, segments } = req.body;

  // Support both 'segments' and 'transcript_segments' for backward compatibility
  const actualSegments = transcript_segments || segments;
  if (actualSegments) {
    req.body.transcript_segments = actualSegments;
  }

  if (message && (typeof message !== 'string' || message.length > 5000)) {
    return res.status(400).json({ error: 'Invalid message format or too long' });
  }

  if (actualSegments && (!Array.isArray(actualSegments) || actualSegments.length > 100)) {
    return res.status(400).json({ error: 'Invalid transcript format or too many segments' });
  }

  next();
}

function validateNodeData(req, res, next) {
  const { name, type } = req.body;

  if (!name || typeof name !== 'string' || name.length > 200) {
    return res.status(400).json({ error: 'Invalid node name' });
  }

  if (
    !type ||
    typeof type !== 'string' ||
    !['person', 'location', 'event', 'concept'].includes(type)
  ) {
    return res.status(400).json({ error: 'Invalid node type' });
  }

  next();
}

app.get('/overview', (req, res) => {
  res.sendFile(__dirname + '/public/overview.html');
});

app.get('/', async (req, res) => {
  const uid = req.query.uid;

  if (uid && typeof uid === 'string' && uid.length >= 3 && uid.length <= 50) {
    try {
      const sanitizedUid = uid.replace(/[^a-zA-Z0-9-_]/g, '');

      await supabase.from('brain_users').upsert([
        {
          uid: sanitizedUid,
        },
      ]);

      req.session.userId = sanitizedUid;
      req.session.loginTime = new Date().toISOString();

      logger.info('User auto-login successful', { uid: sanitizedUid });

      return res.redirect('/');
    } catch (error) {
      logger.error('Auto-login error', { error: error.message, stack: error.stack });
    }
  }

  res.sendFile(__dirname + '/public/main.html');
});

// Login route
app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

// Auth endpoints
app.post('/api/auth/login', authLimiter, validateUid, async (req, res) => {
  try {
    metrics.authenticationAttempts++;
    const uid = req.uid;

    // Create or update user record
    await supabase.from('brain_users').upsert([
      {
        uid: uid,
      },
    ]);

    // Set session and ensure it's saved
    req.session.userId = uid;
    req.session.loginTime = new Date().toISOString();

    // Force session save
    req.session.save((err) => {
      if (err) {
        logger.error('Session save error', { requestId: req.requestId, error: err.message, uid });
        return res.status(500).json({ error: 'Login failed' });
      }

      logger.info('User login successful', { requestId: req.requestId, uid });
      res.json({
        success: true,
        uid: uid,
      });
    });
  } catch (error) {
    logger.error('Login error', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', authLimiter, (req, res) => {
  const uid = req.session?.userId;
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error', { error: err.message, uid });
      return res.status(500).json({ error: 'Logout failed' });
    }
    logger.info('User logout successful', { uid });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Profile endpoint
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { data: rows } = await supabase.from('brain_users').select().eq('uid', uid);

    if (rows && rows.length > 0) {
      res.json({
        uid: rows[0].uid,
        loginTime: req.session.loginTime,
      });
    } else {
      logger.warn('Profile not found', { uid });
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    logger.error('Profile error', { error: error.message, uid });
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

app.get('/setup', async (req, res) => {
  res.json({ is_setup_completed: true });
});

// Edit node endpoint
app.put('/api/node/:nodeId', apiLimiter, requireAuth, validateNodeData, async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { name, type } = req.body;
    const uid = req.uid;

    if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 100) {
      return res.status(400).json({ error: 'Invalid node ID' });
    }

    await supabase
      .from('memory_nodes')
      .update({
        name: name,
        type: type,
      })
      .eq('uid', uid)
      .eq('node_id', nodeId);

    // Get updated memory graph
    const memoryGraph = await loadMemoryGraph(uid);
    const visualizationData = {
      nodes: Array.from(memoryGraph.nodes.values()),
      relationships: memoryGraph.relationships,
    };

    res.json(visualizationData);
  } catch (error) {
    logger.error('Node update error', {
      error: error.message,
      uid,
      nodeId,
    });
    res.status(500).json({ error: 'Error updating node' });
  }
});

// Delete node endpoint
app.delete('/api/node/:nodeId', apiLimiter, requireAuth, async (req, res) => {
  const { nodeId } = req.params;
  const uid = req.uid;

  if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 100) {
    return res.status(400).json({ error: 'Invalid node ID' });
  }

  try {
    await supabase
      .from('memory_relationships')
      .delete()
      .eq('uid', uid)
      .or(`source.eq.${nodeId},target.eq.${nodeId}`);

    await supabase.from('memory_nodes').delete().eq('uid', uid).eq('node_id', nodeId);

    // Get updated memory graph
    const memoryGraph = await loadMemoryGraph(uid);
    const visualizationData = {
      nodes: Array.from(memoryGraph.nodes.values()),
      relationships: memoryGraph.relationships,
    };

    res.json(visualizationData);
  } catch (error) {
    logger.error('Node deletion error', {
      error: error.message,
      uid,
      nodeId,
    });
    res.status(500).json({ error: 'Error deleting node' });
  }
});

// Protected API endpoints
app.post('/api/chat', apiLimiter, requireAuth, validateTextInput, async (req, res) => {
  try {
    const { message } = req.body;
    const uid = req.uid;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await processChatWithGPT(uid, message);
    res.json({ response });
  } catch (error) {
    logger.error('Chat processing error', {
      error: error.message,
      uid,
      messageLength: message?.length || 0,
    });
    res.status(500).json({ error: 'Error processing chat' });
  }
});

function addSampleData(uid, numNodes = 3000, numRelationships = 5000) {
  const types = ['person', 'location', 'event', 'concept'];
  const actions = ['knows', 'lives_in', 'attended', 'connected_to', 'influenced', 'created'];

  const firstNames = [
    'Liam',
    'Emma',
    'Noah',
    'Olivia',
    'Ethan',
    'Ava',
    'James',
    'Sophia',
    'Lucas',
    'Mia',
  ];
  const lastNames = [
    'Johnson',
    'Smith',
    'Brown',
    'Williams',
    'Taylor',
    'Anderson',
    'Davis',
    'Miller',
    'Wilson',
    'Moore',
  ];
  const places = [
    'New York',
    'Berlin',
    'Tokyo',
    'London',
    'Paris',
    'Sydney',
    'Toronto',
    'Madrid',
    'Rome',
    'Amsterdam',
  ];
  const events = [
    'Tech Conference',
    'Music Festival',
    'Art Exhibition',
    'Startup Meetup',
    'Science Fair',
  ];
  const concepts = [
    'Quantum Computing',
    'AI Ethics',
    'Sustainable Energy',
    'Blockchain Security',
    'Neural Networks',
  ];

  let nodes = [];
  let relationships = [];

  for (let i = 0; i < numNodes; i++) {
    const id = `node-${i}`;
    const type = getRandomElement(types);
    let name;

    switch (type) {
      case 'Person':
        name = `${getRandomElement(firstNames)} ${getRandomElement(lastNames)}`;
        break;
      case 'Location':
        name = getRandomElement(places);
        break;
      case 'Event':
        name = getRandomElement(events);
        break;
      case 'Concept':
        name = getRandomElement(concepts);
        break;
    }

    nodes.push({ id, type, name, uid });
  }

  for (let i = 0; i < numRelationships; i++) {
    const source = getRandomElement(nodes).id;
    const target = getRandomElement(nodes).id;
    if (source !== target) {
      const action = getRandomElement(actions);
      relationships.push({ source, target, action, uid });
    }
  }

  return { nodes, relationships };
}

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Get current memory graph
app.get('/api/memory-graph', apiLimiter, requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const sample = req.query.sample === 'true';

    let memoryGraph = await loadMemoryGraph(uid);

    if (sample) {
      memoryGraph = addSampleData(uid, 500, 800);
    }
    const visualizationData = {
      nodes: Array.from(memoryGraph.nodes.values()),
      relationships: memoryGraph.relationships,
    };

    res.json(visualizationData);
  } catch (error) {
    logger.error('Memory graph fetch error', {
      error: error.message,
      uid,
      sample: req.query.sample,
    });
    res.status(500).json({ error: 'Error fetching memory graph' });
  }
});

app.post('/api/process-text', apiLimiter, requireAuth, validateTextInput, async (req, res) => {
  try {
    const { transcript_segments, segments } = req.body;
    const uid = req.uid;

    // Support both 'segments' and 'transcript_segments' for backward compatibility
    const actualSegments = transcript_segments || segments;

    if (!actualSegments || !Array.isArray(actualSegments)) {
      return res.status(400).json({ error: 'Transcript segments are required' });
    }

    let text = '';
    for (const segment of actualSegments) {
      if (segment.speaker && segment.text) {
        text += segment.speaker + ': ' + segment.text + '\n';
      }
    }

    if (!text.trim()) {
      return res.status(400).json({ error: 'No valid text content found' });
    }

    const processedData = await processTextWithGPT(text);
    await saveMemoryGraph(uid, processedData);

    // Get updated memory graph
    const memoryGraph = await loadMemoryGraph(uid);
    const visualizationData = {
      nodes: Array.from(memoryGraph.nodes.values()),
      relationships: memoryGraph.relationships,
    };

    res.json(visualizationData);
  } catch (error) {
    logger.error('Text processing error', {
      error: error.message,
      uid,
      segmentCount: actualSegments?.length || 0,
    });
    res.status(500).json({ error: 'Error processing text' });
  }
});

// Delete all user data
async function deleteAllUserData(uid) {
  try {
    await supabase.from('memory_relationships').delete().eq('uid', uid);
    await supabase.from('memory_nodes').delete().eq('uid', uid);
    await supabase.from('brain_users').delete().eq('uid', uid);

    return true;
  } catch (error) {
    logger.error('Error deleting user data', {
      error: error.message,
      uid,
    });
    throw error;
  }
}

// API Endpoints
app.post('/api/delete-all-data', authLimiter, requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    await deleteAllUserData(uid);

    // Destroy session since user data is deleted
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
      }
    });

    res.json({ success: true, message: 'All data deleted successfully' });
  } catch (error) {
    console.error('Error in delete-all-data endpoint:', error);
    res.status(500).json({ error: 'Failed to delete data' });
  }
});

// Input validation middleware
const validateInput = (req, res, next) => {
  const { query, type } = req.body;

  if (!query || typeof query !== 'string' || query.length > 200) {
    return res.status(400).json({
      error: 'Invalid query parameter',
    });
  }

  if (!type || typeof type !== 'string' || type.length > 50) {
    return res.status(400).json({
      error: 'Invalid type parameter',
    });
  }

  // Remove any potentially harmful characters
  req.body.query = query.replace(/[^\w\s-]/g, '');
  req.body.type = type.replace(/[^\w\s-]/g, '');

  next();
};

// Enrich content endpoint
// Generate node description
app.post('/api/generate-description', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { node, connections } = req.body;

    if (!node || !node.name || !node.type) {
      return res.status(400).json({ error: 'Invalid node data' });
    }

    if (!connections || !Array.isArray(connections)) {
      return res.status(400).json({ error: 'Invalid connections data' });
    }

    const prompt = `Analyze this node and its connections in a brain-like memory network:

Node: ${node.name} (Type: ${node.type})

Connections:
${connections.map((c) => `- ${c.isSource ? 'Connects to' : 'Connected from'} ${c.node.name} through action: ${c.action}`).join('\n')}

Provide a concise but insightful description that:
1. Summarizes the node's role and significance
2. Highlights key relationships and patterns
3. Suggests potential implications or insights

Keep the description natural and engaging, focusing on the most meaningful connections.`;

    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You are an insightful analyst helping understand connections in a memory network. Focus on meaningful patterns and relationships.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 200,
    });

    res.json({ description: completion.choices[0].message.content });
  } catch (error) {
    console.error('Error generating description:', error);
    res.status(500).json({ error: 'Failed to generate description' });
  }
});

app.post('/api/enrich-content', apiLimiter, requireAuth, validateInput, async (req, res) => {
  try {
    const { query, type } = req.body;

    // Configure axios with proper headers and timeout
    const axiosConfig = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      timeout: 5000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300,
    };

    // Search for images with rate limiting
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' ' + type)}&tbm=isch`;

    const response = await axios.get(searchUrl, axiosConfig);
    const cleanHtml = sanitizeHtml(response.data, {
      allowedTags: [],
      allowedAttributes: {},
      textFilter: function (text) {
        return text.replace(/[^\x20-\x7E]/g, '');
      },
    });

    // Extract and validate image URLs
    const regex = /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif))"/gi;
    const images = [];
    const seenUrls = new Set();
    let match;

    while ((match = regex.exec(cleanHtml)) !== null && images.length < 4) {
      try {
        const imageUrl = match[1];

        // Skip if we've seen this URL before
        if (seenUrls.has(imageUrl)) {
          continue;
        }

        // Validate URL
        const parsedUrl = new URL(imageUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          continue;
        }

        // Add valid image
        images.push({
          url: imageUrl,
          title: `Related image for ${query}`,
          source: parsedUrl.hostname,
        });

        seenUrls.add(imageUrl);
      } catch (err) {
        console.warn('Invalid image URL found:', err.message);
        continue;
      }
    }

    // Return results with appropriate cache headers
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({
      images,
      links: [],
      query,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error enriching content:', error);

    // Handle specific error types
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: 'Request timeout',
        images: [],
        links: [],
      });
    }

    if (axios.isAxiosError(error) && error.response) {
      return res.status(error.response.status || 500).json({
        error: 'External service error',
        images: [],
        links: [],
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      images: [],
      links: [],
    });
  }
});

// Error pages
app.use((req, res) => {
  logger.warn('404 - Page not found', {
    requestId: req.requestId,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });
  res.status(404).sendFile(__dirname + '/public/404.html');
});

app.use((err, req, res, _next) => {
  const result = handleDatabaseError(err, 'request handling');
  logger.error('Unhandled error', {
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
  });
  res.status(result.status).sendFile(__dirname + '/public/500.html');
});

// Graceful shutdown handling
// Graceful shutdown using HTTP server close
function initiateGracefulShutdown(signal) {
  logger.info(`${signal} received, initiating graceful shutdown`);
  try {
    server.close((err) => {
      if (err) {
        logger.error('Error while closing server', { error: err.message });
        process.exit(1);
      }
      logger.info('HTTP server closed gracefully');
      process.exit(0);
    });
    // Force exit if not closed in time
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  } catch (err) {
    logger.error('Unexpected error during shutdown', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => initiateGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => initiateGracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason,
    promise,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

// Start server
const server = app.listen(port, () => {
  logger.info(`Server started successfully`, {
    port,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
  });
});
