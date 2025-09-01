#!/usr/bin/env node

const axios = require('axios');
const BASE_URL = 'http://localhost:5001';
const TEST_UID = 'test-user-' + Date.now();

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = colors.reset) {
  console.log(color + message + colors.reset);
}

function logSection(title) {
  console.log('\n' + colors.bright + colors.blue + '═══ ' + title + ' ═══' + colors.reset);
}

function logSuccess(test) {
  log('✓ ' + test, colors.green);
}

function logError(test, error) {
  log('✗ ' + test + ': ' + (error.response?.data?.error || error.message), colors.red);
}

async function testEndpoint(name, method, url, data = null, headers = {}) {
  try {
    const config = {
      method,
      url: BASE_URL + url,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    
    if (data) {
      config.data = data;
    }
    
    const response = await axios(config);
    logSuccess(name);
    return response.data;
  } catch (error) {
    logError(name, error);
    return null;
  }
}

async function runTests() {
  log('\n🧪 Starting Friend App Endpoint Tests\n', colors.bright);
  log(`Testing with UID: ${TEST_UID}`, colors.yellow);

  // 1. HEALTH & STATUS ENDPOINTS
  logSection('Health & Status Endpoints');
  await testEndpoint('GET /health', 'GET', '/health');
  await testEndpoint('GET /webhook/setup-status', 'GET', '/webhook/setup-status');

  // 2. USER DATA ENDPOINTS
  logSection('User Data Management');
  const dashboardData = await testEndpoint(
    'POST /dashboardData - Create user', 
    'POST', 
    '/dashboardData',
    { uid: TEST_UID }
  );
  
  await testEndpoint(
    'POST /get - Get user settings',
    'POST',
    '/get',
    { uid: TEST_UID }
  );

  // 3. SETTINGS MANAGEMENT
  logSection('Settings Management');
  await testEndpoint(
    'POST /save - Save settings',
    'POST',
    '/save',
    {
      uid: TEST_UID,
      responsepercentage: 25,
      cooldown: 10,
      customInstruction: 'Be helpful and friendly',
      personality: 'friendly:80,helpful:90,creative:70'
    }
  );

  await testEndpoint(
    'POST /get - Verify saved settings',
    'POST',
    '/get',
    { uid: TEST_UID }
  );

  // 4. WEBHOOK TESTING
  logSection('Webhook Functionality');
  const webhookData = {
    session_id: TEST_UID,
    segments: [
      { text: "Hello, how are you today?", is_user: true, start: Date.now()/1000 },
      { text: "I'm doing great, thanks!", is_user: false, start: Date.now()/1000 + 1 },
      { text: "What's the weather like?", is_user: true, start: Date.now()/1000 + 2 }
    ]
  };

  await testEndpoint(
    'POST /webhook - Send conversation',
    'POST',
    '/webhook',
    webhookData
  );

  // Wait a bit for processing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Send more segments to trigger analysis
  for (let i = 0; i < 5; i++) {
    webhookData.segments.push({
      text: `Test message ${i} for analytics`,
      is_user: i % 2 === 0,
      start: Date.now()/1000 + i + 3
    });
  }
  
  await testEndpoint(
    'POST /webhook - Trigger analysis',
    'POST',
    '/webhook',
    webhookData
  );

  // 5. ANALYTICS ENDPOINTS
  logSection('Analytics & Insights');
  await testEndpoint(
    'GET /analytics',
    'GET',
    `/analytics?uid=${TEST_UID}`
  );

  await testEndpoint(
    'GET /insights',
    'GET',
    `/insights?uid=${TEST_UID}`
  );

  // 6. GOALS MANAGEMENT
  logSection('Goals Management');
  const goalData = await testEndpoint(
    'POST /goals - Add goal',
    'POST',
    '/goals',
    {
      uid: TEST_UID,
      type: 'fitness',
      target: 'Exercise 3 times per week'
    }
  );

  await testEndpoint(
    'GET /goals - Get goals',
    'GET',
    `/goals?uid=${TEST_UID}`
  );

  if (goalData?.goal?.id) {
    await testEndpoint(
      'DELETE /goals/:id - Delete goal',
      'DELETE',
      `/goals/${goalData.goal.id}?uid=${TEST_UID}`
    );
  }

  // 7. CHAT TEST
  logSection('AI Chat Features');
  await testEndpoint(
    'POST /chat-test',
    'POST',
    '/chat-test',
    {
      message: 'Hello! Can you help me test this endpoint?',
      personality: 'friendly:90,helpful:100',
      prompt: 'You are a helpful assistant'
    }
  );

  // 8. IMAGE GENERATION
  logSection('Image Generation');
  await testEndpoint(
    'GET /generate-image',
    'GET',
    `/generate-image?uid=${TEST_UID}`
  );

  // 9. WEB INTERFACE PAGES
  logSection('Web Interface Pages');
  await testEndpoint('GET / (Enter UID page)', 'GET', '/');
  await testEndpoint('GET /?uid=test (Dashboard)', 'GET', `/?uid=${TEST_UID}`);
  await testEndpoint('GET /settings', 'GET', `/settings?uid=${TEST_UID}`);
  await testEndpoint('GET /privacyPolicy', 'GET', '/privacyPolicy');

  // 10. RATE LIMITING TEST
  logSection('Rate Limiting Test');
  log('Testing rate limits (may show errors - this is expected)', colors.yellow);
  
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(
      testEndpoint(
        `Rate limit test ${i+1}`,
        'POST',
        '/chat-test',
        { message: 'Rate limit test', personality: '', prompt: '' }
      )
    );
  }
  await Promise.all(promises);

  // 11. INPUT VALIDATION TESTS
  logSection('Input Validation Tests');
  
  await testEndpoint(
    'Invalid UID format test',
    'POST',
    '/save',
    {
      uid: 'a'.repeat(100), // Too long
      responsepercentage: 50
    }
  );

  await testEndpoint(
    'Invalid response percentage',
    'POST',
    '/save',
    {
      uid: TEST_UID,
      responsepercentage: 150 // Out of range
    }
  );

  await testEndpoint(
    'XSS prevention test',
    'POST',
    '/save',
    {
      uid: TEST_UID,
      customInstruction: '<script>alert("xss")</script>Test',
      responsepercentage: 50
    }
  );

  // 12. CLEANUP
  logSection('Cleanup');
  await testEndpoint(
    'POST /deleteuser - Clean up test user',
    'POST',
    '/deleteuser',
    { uid: TEST_UID }
  );

  log('\n✅ Test suite completed!\n', colors.bright + colors.green);
}

// Run tests
runTests().catch(error => {
  log('\n❌ Test suite failed: ' + error.message, colors.bright + colors.red);
  process.exit(1);
});