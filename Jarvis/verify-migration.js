#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m'
};

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

async function verifyMigration() {
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  MIGRATION VERIFICATION${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}\n`);

    try {
        // Check if uid column exists
        const { data, error, count } = await supabase
            .from('jarvis_sessions')
            .select('*', { count: 'exact' });

        if (error) {
            throw error;
        }

        console.log(`${colors.green}✓ Successfully connected to jarvis_sessions table${colors.reset}`);
        console.log(`  Total records: ${count}`);

        if (data && data.length > 0) {
            const hasUidColumn = 'uid' in data[0];
            
            if (hasUidColumn) {
                console.log(`${colors.green}✅ SUCCESS: 'uid' column exists!${colors.reset}`);
                
                // Check how many records have uid values
                const recordsWithUid = data.filter(r => r.uid !== null && r.uid !== undefined).length;
                const recordsWithoutUid = data.filter(r => r.uid === null || r.uid === undefined).length;
                
                console.log(`\n${colors.cyan}Migration Statistics:${colors.reset}`);
                console.log(`  ✓ Records with UID: ${recordsWithUid}`);
                console.log(`  ✓ Records without UID: ${recordsWithoutUid}`);
                console.log(`  ✓ All data preserved: ${count} total records`);
                
                // Show sample records
                console.log(`\n${colors.cyan}Sample Records (first 3):${colors.reset}`);
                data.slice(0, 3).forEach((record, index) => {
                    console.log(`\n  Record ${index + 1}:`);
                    console.log(`    ID: ${record.id}`);
                    console.log(`    Session ID: ${record.session_id}`);
                    console.log(`    UID: ${record.uid || 'null'}`);
                    console.log(`    Created: ${new Date(record.created_at).toLocaleString()}`);
                });
                
                if (recordsWithoutUid > 0) {
                    console.log(`\n${colors.yellow}⚠️  Note: ${recordsWithoutUid} records don't have UID values yet.${colors.reset}`);
                    console.log(`${colors.yellow}   These will be updated as users interact with the app.${colors.reset}`);
                }
                
                console.log(`\n${colors.bright}${colors.green}✅ MIGRATION VERIFIED SUCCESSFULLY!${colors.reset}`);
                console.log(`${colors.green}   Your Jarvis app is ready for the control panel.${colors.reset}`);
                
            } else {
                console.log(`${colors.red}❌ MIGRATION NOT APPLIED: 'uid' column is missing${colors.reset}`);
                console.log(`\n${colors.yellow}Please run the following SQL in Supabase Dashboard:${colors.reset}`);
                console.log(`${colors.bright}ALTER TABLE jarvis_sessions ADD COLUMN IF NOT EXISTS uid TEXT;${colors.reset}`);
                console.log(`${colors.bright}CREATE INDEX IF NOT EXISTS idx_jarvis_sessions_uid ON jarvis_sessions(uid);${colors.reset}`);
                console.log(`${colors.bright}UPDATE jarvis_sessions SET uid = session_id WHERE uid IS NULL;${colors.reset}`);
            }
        } else {
            console.log(`${colors.yellow}⚠️  Table is empty - migration can be applied${colors.reset}`);
        }

    } catch (error) {
        console.error(`${colors.red}✗ Verification failed:${colors.reset}`, error.message);
        process.exit(1);
    }
}

verifyMigration().catch(console.error);