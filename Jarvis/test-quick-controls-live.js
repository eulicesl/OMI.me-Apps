#!/usr/bin/env node

const https = require('https');

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
                'Content-Type': 'application/json'
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
                    data: responseData
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

async function testQuickAccessControls() {
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  QUICK ACCESS CONTROLS TEST${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}\n`);
    console.log(`Testing: https://${PROD_URL}`);
    console.log(`Your UID: ${YOUR_UID}\n`);

    let passedTests = 0;
    let failedTests = 0;

    // Test 1: Check if Quick Access Control buttons are present in HTML
    console.log(`${colors.bright}${colors.blue}Test 1: Quick Access Control Buttons in UI${colors.reset}`);
    try {
        const response = await makeRequest(`/?uid=${YOUR_UID}`);
        const quickButtons = [
            { name: 'ADD TASK', func: 'addTask' },
            { name: 'REMINDER', func: 'addReminder' },
            { name: 'EVENT', func: 'addEvent' },
            { name: 'NOTE', func: 'addNote' }
        ];
        
        console.log(`Checking Quick Access Control buttons:`);
        let allPresent = true;
        quickButtons.forEach(btn => {
            const hasButton = response.data.includes(`onclick="${btn.func}()"`);
            if (hasButton) {
                console.log(`  ${colors.green}✓${colors.reset} ${btn.name} button found`);
            } else {
                console.log(`  ${colors.red}✗${colors.reset} ${btn.name} button missing`);
                allPresent = false;
            }
        });
        
        if (allPresent) {
            console.log(`${colors.green}✅ PASS: All Quick Access Control buttons present${colors.reset}`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Some buttons missing${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 2: Check if button functions are defined
    console.log(`\n${colors.bright}${colors.blue}Test 2: Button Functions Defined${colors.reset}`);
    try {
        const response = await makeRequest(`/?uid=${YOUR_UID}`);
        const functions = ['addTask', 'addReminder', 'addEvent', 'addNote'];
        
        console.log(`Checking function definitions:`);
        let allDefined = true;
        functions.forEach(func => {
            const hasDef = response.data.includes(`function ${func}(`) || 
                          response.data.includes(`${func} = function`) ||
                          response.data.includes(`const ${func} =`);
            if (hasDef) {
                console.log(`  ${colors.green}✓${colors.reset} ${func}() function defined`);
            } else {
                console.log(`  ${colors.red}✗${colors.reset} ${func}() function not found`);
                allDefined = false;
            }
        });
        
        if (allDefined) {
            console.log(`${colors.green}✅ PASS: All functions defined${colors.reset}`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Some functions missing${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 3: Test ADD TASK functionality
    console.log(`\n${colors.bright}${colors.blue}Test 3: ADD TASK Functionality${colors.reset}`);
    try {
        const testTask = {
            uid: YOUR_UID,
            type: 'task',
            text: 'Test Task - ' + new Date().toLocaleTimeString(),
            date: ''
        };
        
        const response = await makeRequest('/api/actions', 'POST', testTask);
        if (response.statusCode === 200) {
            const created = JSON.parse(response.data);
            console.log(`${colors.green}✅ PASS: Task created successfully${colors.reset}`);
            console.log(`  Task ID: ${created.id}`);
            console.log(`  Text: "${created.text}"`);
            
            // Clean up
            await makeRequest(`/api/actions/${created.id}?uid=${YOUR_UID}`, 'DELETE');
            console.log(`  Cleaned up test task`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Could not create task${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 4: Test REMINDER functionality
    console.log(`\n${colors.bright}${colors.blue}Test 4: REMINDER Functionality${colors.reset}`);
    try {
        const testReminder = {
            uid: YOUR_UID,
            type: 'reminder',
            text: 'Test Reminder - ' + new Date().toLocaleTimeString(),
            date: new Date(Date.now() + 3600000).toISOString() // 1 hour from now
        };
        
        const response = await makeRequest('/api/actions', 'POST', testReminder);
        if (response.statusCode === 200) {
            const created = JSON.parse(response.data);
            console.log(`${colors.green}✅ PASS: Reminder created successfully${colors.reset}`);
            console.log(`  Reminder ID: ${created.id}`);
            console.log(`  Text: "${created.text}"`);
            console.log(`  Due: ${new Date(created.date).toLocaleTimeString()}`);
            
            // Clean up
            await makeRequest(`/api/actions/${created.id}?uid=${YOUR_UID}`, 'DELETE');
            console.log(`  Cleaned up test reminder`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Could not create reminder${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 5: Test EVENT functionality
    console.log(`\n${colors.bright}${colors.blue}Test 5: EVENT Functionality${colors.reset}`);
    try {
        const testEvent = {
            uid: YOUR_UID,
            type: 'event',
            text: 'Test Event - ' + new Date().toLocaleTimeString(),
            date: new Date(Date.now() + 86400000).toISOString() // Tomorrow
        };
        
        const response = await makeRequest('/api/actions', 'POST', testEvent);
        if (response.statusCode === 200) {
            const created = JSON.parse(response.data);
            console.log(`${colors.green}✅ PASS: Event created successfully${colors.reset}`);
            console.log(`  Event ID: ${created.id}`);
            console.log(`  Text: "${created.text}"`);
            console.log(`  Date: ${new Date(created.date).toLocaleDateString()}`);
            
            // Clean up
            await makeRequest(`/api/actions/${created.id}?uid=${YOUR_UID}`, 'DELETE');
            console.log(`  Cleaned up test event`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Could not create event${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Test 6: Test NOTE functionality
    console.log(`\n${colors.bright}${colors.blue}Test 6: NOTE Functionality${colors.reset}`);
    try {
        const testNote = {
            uid: YOUR_UID,
            type: 'note',
            text: 'Test Note - ' + new Date().toLocaleTimeString(),
            date: ''
        };
        
        const response = await makeRequest('/api/actions', 'POST', testNote);
        if (response.statusCode === 200) {
            const created = JSON.parse(response.data);
            console.log(`${colors.green}✅ PASS: Note created successfully${colors.reset}`);
            console.log(`  Note ID: ${created.id}`);
            console.log(`  Text: "${created.text}"`);
            
            // Clean up
            await makeRequest(`/api/actions/${created.id}?uid=${YOUR_UID}`, 'DELETE');
            console.log(`  Cleaned up test note`);
            passedTests++;
        } else {
            console.log(`${colors.red}❌ FAIL: Could not create note${colors.reset}`);
            failedTests++;
        }
    } catch (error) {
        console.log(`${colors.red}❌ FAIL: ${error.message}${colors.reset}`);
        failedTests++;
    }

    // Summary
    console.log(`\n${colors.bright}${colors.magenta}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.magenta}  QUICK ACCESS CONTROLS STATUS${colors.reset}`);
    console.log(`${colors.bright}${colors.magenta}========================================${colors.reset}\n`);
    
    const totalTests = passedTests + failedTests;
    const successRate = ((passedTests / totalTests) * 100).toFixed(1);
    
    console.log(`${colors.green}Passed: ${passedTests}/${totalTests}${colors.reset}`);
    console.log(`${colors.red}Failed: ${failedTests}/${totalTests}${colors.reset}`);
    console.log(`Success Rate: ${successRate}%\n`);
    
    if (failedTests === 0) {
        console.log(`${colors.bright}${colors.green}🎉 QUICK ACCESS CONTROLS FULLY FUNCTIONAL!${colors.reset}`);
        console.log(`${colors.green}✅ ADD TASK button works${colors.reset}`);
        console.log(`${colors.green}✅ REMINDER button works${colors.reset}`);
        console.log(`${colors.green}✅ EVENT button works${colors.reset}`);
        console.log(`${colors.green}✅ NOTE button works${colors.reset}`);
    } else if (failedTests <= 2) {
        console.log(`${colors.bright}${colors.yellow}⚠️  Most controls working, minor issues detected${colors.reset}`);
    } else {
        console.log(`${colors.bright}${colors.red}❌ Quick Access Controls need attention${colors.reset}`);
    }
    
    console.log(`\n${colors.cyan}How Quick Access Controls Work:${colors.reset}`);
    console.log(`1. Click any button (ADD TASK, REMINDER, EVENT, NOTE)`);
    console.log(`2. A modal opens with input fields`);
    console.log(`3. Fill in details and click SAVE`);
    console.log(`4. Item is saved to database instantly`);
    
    console.log(`\n${colors.bright}${colors.blue}Access your panel:${colors.reset}`);
    console.log(`${colors.cyan}https://${PROD_URL}/?uid=${YOUR_UID}${colors.reset}`);
}

// Run the test
testQuickAccessControls().catch(console.error);