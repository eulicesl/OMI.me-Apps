#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m'
};

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

async function checkDatabase() {
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  SUPABASE DATABASE STRUCTURE CHECK${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}\n`);

    try {
        // Check jarvis_sessions table
        console.log(`${colors.bright}${colors.yellow}📊 Checking 'jarvis_sessions' table...${colors.reset}`);
        
        const { data: jarvisSessions, error: jarvisError, count: jarvisCount } = await supabase
            .from('jarvis_sessions')
            .select('*', { count: 'exact' })
            .limit(1);

        if (jarvisError) {
            console.log(`${colors.red}✗ Table 'jarvis_sessions' not found or error accessing it${colors.reset}`);
            console.log(`  Error: ${jarvisError.message}`);
        } else {
            console.log(`${colors.green}✓ Table 'jarvis_sessions' exists${colors.reset}`);
            console.log(`  Total records: ${jarvisCount || 0}`);
            
            if (jarvisSessions && jarvisSessions.length > 0) {
                console.log(`\n  ${colors.cyan}Column structure:${colors.reset}`);
                const columns = Object.keys(jarvisSessions[0]);
                columns.forEach(col => {
                    const value = jarvisSessions[0][col];
                    const type = value === null ? 'null' : typeof value;
                    const hasUid = col === 'uid' ? `${colors.green} ← UID COLUMN EXISTS${colors.reset}` : '';
                    console.log(`    • ${col} (${type})${hasUid}`);
                });
            }
        }

        // Check frienddb table
        console.log(`\n${colors.bright}${colors.yellow}📊 Checking 'frienddb' table...${colors.reset}`);
        
        const { data: friendDb, error: friendError, count: friendCount } = await supabase
            .from('frienddb')
            .select('*', { count: 'exact' })
            .limit(1);

        if (friendError) {
            console.log(`${colors.red}✗ Table 'frienddb' not found or error accessing it${colors.reset}`);
            console.log(`  Error: ${friendError.message}`);
        } else {
            console.log(`${colors.green}✓ Table 'frienddb' exists${colors.reset}`);
            console.log(`  Total records: ${friendCount || 0}`);
            
            if (friendDb && friendDb.length > 0) {
                console.log(`\n  ${colors.cyan}Column structure:${colors.reset}`);
                const columns = Object.keys(friendDb[0]);
                columns.forEach(col => {
                    const value = friendDb[0][col];
                    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
                    console.log(`    • ${col} (${type})`);
                });
            }
        }

        // Check if we need migration
        console.log(`\n${colors.bright}${colors.magenta}========================================${colors.reset}`);
        console.log(`${colors.bright}${colors.magenta}  MIGRATION STATUS${colors.reset}`);
        console.log(`${colors.bright}${colors.magenta}========================================${colors.reset}\n`);

        if (jarvisSessions && jarvisSessions.length > 0) {
            if ('uid' in jarvisSessions[0]) {
                console.log(`${colors.green}✅ NO MIGRATION NEEDED - 'uid' column already exists${colors.reset}`);
                
                // Check how many records have uid values
                const { data: uidCheck, count: uidCount } = await supabase
                    .from('jarvis_sessions')
                    .select('uid', { count: 'exact' })
                    .not('uid', 'is', null);
                
                console.log(`\n${colors.cyan}UID Statistics:${colors.reset}`);
                console.log(`  Records with UID: ${uidCount || 0}`);
                console.log(`  Records without UID: ${(jarvisCount || 0) - (uidCount || 0)}`);
                
            } else {
                console.log(`${colors.yellow}⚠️  MIGRATION NEEDED - 'uid' column is missing${colors.reset}`);
                console.log(`\n${colors.cyan}Migration will:${colors.reset}`);
                console.log(`  1. Add 'uid' column to jarvis_sessions table`);
                console.log(`  2. Create index on uid column for better performance`);
                console.log(`  3. Set uid = session_id for existing records`);
                console.log(`  4. Preserve all existing data`);
                console.log(`\n${colors.yellow}Run 'node safe-migration.js' to apply migration${colors.reset}`);
            }
        } else if (!jarvisError) {
            console.log(`${colors.yellow}⚠️  Table is empty - migration can be applied safely${colors.reset}`);
        }

        // Show recent sessions
        if (jarvisCount && jarvisCount > 0) {
            console.log(`\n${colors.bright}${colors.cyan}Recent Sessions (last 5):${colors.reset}`);
            const { data: recentSessions } = await supabase
                .from('jarvis_sessions')
                .select('id, session_id, uid, created_at, last_activity')
                .order('created_at', { ascending: false })
                .limit(5);
            
            if (recentSessions) {
                recentSessions.forEach((session, index) => {
                    console.log(`\n  ${index + 1}. Session: ${session.session_id}`);
                    console.log(`     UID: ${session.uid || 'null'}`);
                    console.log(`     Created: ${new Date(session.created_at).toLocaleString()}`);
                    if (session.last_activity) {
                        console.log(`     Last Active: ${new Date(session.last_activity).toLocaleString()}`);
                    }
                });
            }
        }

    } catch (error) {
        console.error(`\n${colors.red}${colors.bright}✗ Database check failed:${colors.reset}`, error);
        console.log(`\n${colors.yellow}Please check your Supabase connection settings in .env${colors.reset}`);
        process.exit(1);
    }

    console.log(`\n${colors.bright}${colors.green}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.green}  CHECK COMPLETED${colors.reset}`);
    console.log(`${colors.bright}${colors.green}========================================${colors.reset}`);
}

// Run the check
checkDatabase().catch(console.error);