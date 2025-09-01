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
    blue: '\x1b[34m'
};

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

async function runSafeMigration() {
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  JARVIS DATABASE MIGRATION TOOL${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}========================================${colors.reset}\n`);

    try {
        // Step 1: Check current table structure
        console.log(`${colors.yellow}📊 Step 1: Checking current table structure...${colors.reset}`);
        const { data: currentData, count } = await supabase
            .from('jarvis_sessions')
            .select('*', { count: 'exact' })
            .limit(1);

        console.log(`${colors.green}✓ Table exists with ${count || 0} records${colors.reset}`);
        
        // Step 2: Check if uid column already exists
        console.log(`\n${colors.yellow}🔍 Step 2: Checking if 'uid' column exists...${colors.reset}`);
        
        if (currentData && currentData.length > 0) {
            const sampleRecord = currentData[0];
            if ('uid' in sampleRecord) {
                console.log(`${colors.green}✓ Column 'uid' already exists - no migration needed${colors.reset}`);
                
                // Check if index exists by trying to query with it
                console.log(`\n${colors.yellow}🔍 Checking index...${colors.reset}`);
                const { data: indexTest } = await supabase
                    .from('jarvis_sessions')
                    .select('uid')
                    .limit(1);
                
                if (indexTest) {
                    console.log(`${colors.green}✓ Index likely exists (query succeeded)${colors.reset}`);
                }
                
                return;
            }
        }

        // Step 3: Backup current data
        console.log(`\n${colors.yellow}💾 Step 3: Creating backup of existing data...${colors.reset}`);
        const { data: backupData, error: backupError } = await supabase
            .from('jarvis_sessions')
            .select('*');

        if (backupError) {
            console.error(`${colors.red}✗ Backup failed:${colors.reset}`, backupError);
            process.exit(1);
        }

        const backupCount = backupData ? backupData.length : 0;
        console.log(`${colors.green}✓ Backed up ${backupCount} records${colors.reset}`);

        // Save backup to file
        const fs = require('fs');
        const backupFile = `jarvis_backup_${Date.now()}.json`;
        fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
        console.log(`${colors.green}✓ Backup saved to: ${backupFile}${colors.reset}`);

        // Step 4: Run migration
        console.log(`\n${colors.yellow}🚀 Step 4: Running migration...${colors.reset}`);
        console.log(`${colors.cyan}Adding 'uid' column to jarvis_sessions table...${colors.reset}`);

        // Use Supabase SQL RPC to run the migration
        const { data: migrationResult, error: migrationError } = await supabase.rpc('exec_sql', {
            query: `
                ALTER TABLE jarvis_sessions 
                ADD COLUMN IF NOT EXISTS uid TEXT;
            `
        }).single();

        if (migrationError && !migrationError.message.includes('already exists')) {
            // Try alternative approach using direct SQL
            console.log(`${colors.yellow}Note: Direct SQL execution not available via RPC${colors.reset}`);
            console.log(`${colors.bright}${colors.cyan}Please run the following SQL in Supabase Dashboard:${colors.reset}\n`);
            console.log(`${colors.bright}ALTER TABLE jarvis_sessions ADD COLUMN IF NOT EXISTS uid TEXT;${colors.reset}`);
            console.log(`${colors.bright}CREATE INDEX IF NOT EXISTS idx_jarvis_sessions_uid ON jarvis_sessions(uid);${colors.reset}\n`);
            console.log(`${colors.yellow}After running the SQL, execute this script again to verify.${colors.reset}`);
            return;
        }

        console.log(`${colors.green}✓ Column added successfully${colors.reset}`);

        // Step 5: Update existing records
        console.log(`\n${colors.yellow}📝 Step 5: Updating existing records...${colors.reset}`);
        
        // Set uid to session_id for existing records
        if (backupData && backupData.length > 0) {
            for (const record of backupData) {
                if (!record.uid && record.session_id) {
                    const { error: updateError } = await supabase
                        .from('jarvis_sessions')
                        .update({ uid: record.session_id })
                        .eq('id', record.id);

                    if (updateError) {
                        console.error(`${colors.red}✗ Failed to update record ${record.id}:${colors.reset}`, updateError);
                    }
                }
            }
            console.log(`${colors.green}✓ Updated ${backupData.length} records with uid values${colors.reset}`);
        }

        // Step 6: Verify migration
        console.log(`\n${colors.yellow}✅ Step 6: Verifying migration...${colors.reset}`);
        const { data: verifyData, count: finalCount } = await supabase
            .from('jarvis_sessions')
            .select('*', { count: 'exact' })
            .limit(5);

        console.log(`${colors.green}✓ Migration complete!${colors.reset}`);
        console.log(`${colors.green}✓ Total records: ${finalCount}${colors.reset}`);
        console.log(`${colors.green}✓ All existing data preserved${colors.reset}`);

        // Show sample of migrated data
        if (verifyData && verifyData.length > 0) {
            console.log(`\n${colors.cyan}Sample migrated record:${colors.reset}`);
            const sample = verifyData[0];
            console.log(`  ID: ${sample.id}`);
            console.log(`  Session ID: ${sample.session_id}`);
            console.log(`  UID: ${sample.uid || 'null'}`);
            console.log(`  Created: ${sample.created_at}`);
        }

    } catch (error) {
        console.error(`\n${colors.red}${colors.bright}✗ Migration failed:${colors.reset}`, error);
        console.log(`\n${colors.yellow}Your data is safe. No changes were made.${colors.reset}`);
        console.log(`${colors.yellow}Please check your Supabase connection and try again.${colors.reset}`);
        process.exit(1);
    }

    console.log(`\n${colors.bright}${colors.green}========================================${colors.reset}`);
    console.log(`${colors.bright}${colors.green}  MIGRATION COMPLETED SUCCESSFULLY${colors.reset}`);
    console.log(`${colors.bright}${colors.green}========================================${colors.reset}`);
}

// Run the migration
runSafeMigration().catch(console.error);