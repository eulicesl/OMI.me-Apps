#!/bin/bash

# Jarvis Production Deployment Script
# This script prepares and deploys the Jarvis app for production

set -e  # Exit on error

echo "🚀 Starting Jarvis Production Deployment..."

# 1. Check environment
echo "📋 Checking environment..."
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create a .env file with your Supabase credentials"
    exit 1
fi

# 2. Install dependencies
echo "📦 Installing dependencies..."
npm install --production

# 3. Run database migration
echo "🗄️ Running database migration..."
echo "Please run the following SQL in your Supabase SQL editor:"
echo "----------------------------------------"
cat add-uid-column.sql
echo "----------------------------------------"
echo "Press enter once you've run the migration..."
read

# 4. Test the server
echo "🧪 Starting server for testing..."
npm start &
SERVER_PID=$!
sleep 3

# Test health endpoint
echo "Testing health endpoint..."
curl -s http://localhost:3000/webhook/setup-status > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ Server is responding correctly"
else
    echo "❌ Server test failed"
    kill $SERVER_PID
    exit 1
fi

kill $SERVER_PID

# 5. Production checklist
echo ""
echo "✅ Production Deployment Checklist:"
echo "-----------------------------------"
echo "[ ] Database migration applied (add-uid-column.sql)"
echo "[ ] Environment variables configured in .env"
echo "[ ] Supabase connection tested"
echo "[ ] OMI webhook URL configured to point to your server"
echo "[ ] Port 3000 is open and accessible"
echo "[ ] SSL/HTTPS configured (recommended for production)"
echo "[ ] Process manager configured (PM2 recommended)"
echo ""
echo "📝 To run in production with PM2:"
echo "  npm install -g pm2"
echo "  pm2 start index.js --name jarvis"
echo "  pm2 save"
echo "  pm2 startup"
echo ""
echo "🎉 Deployment preparation complete!"