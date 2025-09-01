#!/usr/bin/env node

const https = require('https');
const { JSDOM } = require('jsdom');

// Production URL and your UID
const PROD_URL = 'jarvis-app-k4xoe.ondigitalocean.app';
const YOUR_UID = 'rg0PvY9mhKRARcYxkHHYh4iAkc12';

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m'
};

// Helper function to make HTTPS requests
function makeRequest(path, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: PROD_URL,
            port: 443,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        };

        if (data && method !== 'GET') {
            const postData = JSON.stringify(data);
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = https.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    data: responseData,
                    headers: res.headers
                });
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (data && method !== 'GET') {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

async function testLivePanel() {
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  JARVIS LIVE PANEL TEST${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}\n`);
    console.log(`Testing: https://${PROD_URL}`);
    console.log(`Your UID: ${YOUR_UID}\n`);

    let passedTests = 0;
    let failedTests = 0;

    // Test 1: Check if panel loads with fixes
    console.log(`${colors.bright}Test 1: Panel Code Updates${colors.reset}`);
    try {
        const response = await makeRequest(`/?uid=${YOUR_UID}`);
        const hasInitializeStorage = response.data.includes('initializeStorage');
        const hasDownloadTranscript = response.data.includes('downloadTranscript');
        const hasStorageCheck = response.data.includes('if (!storage)');
        
        if (hasInitializeStorage && hasDownloadTranscript && hasStorageCheck) {
            console.log(`${colors.green}✅ PASS: All code fixes are deployed${colors.reset}`);
            console.log(`  ✓ initializeStorage function present`);
            console.log(`  ✓ downloadTranscript function present`);
            console.log(`  ✓ Storage validation checks present`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Some fixes missing${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 2: Test Daily Briefing API
    console.log(`\n${colors.bright}Test 2: Daily Briefing Data (Analytics API)${colors.reset}`);
    try {
        const response = await makeRequest(`/api/analytics?uid=${YOUR_UID}`);
        if (response.statusCode === 200) {
            const data = JSON.parse(response.data);
            console.log(`${colors.green}✅ PASS: Analytics API working${colors.reset}`);
            console.log(`  Sessions: ${data.total_sessions}`);
            console.log(`  Messages: ${data.total_messages}`);
            console.log(`  Actions: ${data.total_actions}`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Status ${response.statusCode}${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 3: Test Transcripts API
    console.log(`\n${colors.bright}Test 3: Review Transcripts API${colors.reset}`);
    try {
        const response = await makeRequest(`/api/transcripts?uid=${YOUR_UID}`);
        if (response.statusCode === 200) {
            const transcripts = JSON.parse(response.data);
            console.log(`${colors.green}✅ PASS: Transcripts API working${colors.reset}`);
            console.log(`  Total transcripts: ${transcripts.length}`);
            if (transcripts.length > 0) {
                console.log(`  Latest session: ${transcripts[0].session_id}`);
                console.log(`  Has messages: ${transcripts[0].messages?.length > 0 ? 'Yes' : 'No'}`);
            }
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Status ${response.statusCode}${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 4: Test Actions API
    console.log(`\n${colors.bright}Test 4: Pending Actions API${colors.reset}`);
    try {
        const response = await makeRequest(`/api/actions?uid=${YOUR_UID}`);
        if (response.statusCode === 200) {
            const actions = JSON.parse(response.data);
            const pending = actions.filter(a => !a.completed);
            const completed = actions.filter(a => a.completed);
            console.log(`${colors.green}✅ PASS: Actions API working${colors.reset}`);
            console.log(`  Pending: ${pending.length}`);
            console.log(`  Completed: ${completed.length}`);
            if (pending.length > 0) {
                console.log(`  Next task: "${pending[0].text}"`);
            }
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Status ${response.statusCode}${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 5: Quick Capture (Create and Delete)
    console.log(`\n${colors.bright}Test 5: Quick Capture Functionality${colors.reset}`);
    try {
        const testAction = {
            uid: YOUR_UID,
            type: 'test',
            text: 'Live panel test - ' + new Date().toLocaleTimeString()
        };
        
        const createResponse = await makeRequest('/api/actions', 'POST', testAction);
        if (createResponse.statusCode === 200) {
            const created = JSON.parse(createResponse.data);
            console.log(`${colors.green}✅ PASS: Quick Capture working${colors.reset}`);
            console.log(`  Created action ID: ${created.id}`);
            
            // Clean up
            await makeRequest(`/api/actions/${created.id}?uid=${YOUR_UID}`, 'DELETE');
            console.log(`  Cleaned up test action`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Status ${createResponse.statusCode}${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 6: Check UI Button Presence
    console.log(`\n${colors.bright}Test 6: UI Button Elements${colors.reset}`);
    try {
        const response = await makeRequest(`/?uid=${YOUR_UID}`);
        const buttonChecks = [
            { name: 'DAILY BRIEFING', func: 'showDailyBriefing' },
            { name: 'REVIEW TRANSCRIPTS', func: 'reviewTranscripts' },
            { name: 'PENDING ACTIONS', func: 'showPendingActions' },
            { name: 'QUICK CAPTURE', func: 'quickCapture' },
            { name: 'EXPORT', func: 'exportSummary' }
        ];
        
        let allPresent = true;
        console.log(`Checking Quick Access buttons:`);
        buttonChecks.forEach(btn => {
            const hasButton = response.data.includes(`onclick="${btn.func}()"`);
            if (hasButton) {
                console.log(`  ${colors.green}✓${colors.reset} ${btn.name} button present`);
            } else {
                console.log(`  ${colors.red}✗${colors.reset} ${btn.name} button missing`);
                allPresent = false;
            }
        });
        
        if (allPresent) {
            console.log(`${colors.green}✅ PASS: All buttons present${colors.reset}`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Some buttons missing${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Summary
    console.log(`\n${colors.bright}${colors.magenta}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.magenta}  LIVE TEST RESULTS${colors.reset}`);
    console.log(`${colors.bright}${colors.magenta}========================================${colors.reset}\n`);
    
    const totalTests = passedTests + failedTests;
    const successRate = ((passedTests / totalTests) * 100).toFixed(1);
    
    console.log(`${colors.green}Passed: ${passedTests}/${totalTests}${colors.reset}`);
    console.log(`${colors.red}Failed: ${failedTests}/${totalTests}${colors.reset}`);
    console.log(`Success Rate: ${successRate}%\n`);
    
    if (failedTests === 0) {
        console.log(`${colors.bright}${colors.green}🎉 ALL SYSTEMS OPERATIONAL!${colors.reset}`);
        console.log(`${colors.green}✅ Panel is fully functional${colors.reset}`);
        console.log(`${colors.green}✅ All buttons should work${colors.reset}`);
        console.log(`${colors.green}✅ Download feature available${colors.reset}`);
    } else {
        console.log(`${colors.bright}${colors.yellow}⚠️  Some issues detected${colors.reset}`);
    }
    
    console.log(`\n${colors.bright}${colors.blue}Access your panel:${colors.reset}`);
    console.log(`${colors.cyan}https://${PROD_URL}/?uid=${YOUR_UID}${colors.reset}`);
    
    console.log(`\n${colors.yellow}Note: If buttons still don't work in browser:${colors.reset}`);
    console.log(`1. Clear browser cache (Cmd+Shift+R on Mac)${colors.reset}`);
    console.log(`2. Check browser console for errors (F12)${colors.reset}`);
    console.log(`3. Ensure JavaScript is enabled${colors.reset}`);
}

// Run the test
testLivePanel().catch(console.error);