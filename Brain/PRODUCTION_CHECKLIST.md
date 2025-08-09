# Brain App Production Deployment Checklist

## ✅ Completed Items

### Security Hardening
- [x] **Helmet.js** - Security headers implemented with comprehensive CSP
- [x] **Rate Limiting** - Three-tier rate limiting (general, auth, API)
- [x] **Compression** - Gzip compression for performance
- [x] **Input Validation** - Express-validator on all endpoints
- [x] **Session Security** - Secure cookies with httpOnly and sameSite
- [x] **CORS Protection** - Configurable allowed origins
- [x] **HTML Sanitization** - sanitize-html for user content

### Logging & Monitoring
- [x] **Winston Logger** - Structured JSON logging with file rotation
- [x] **Request Logging** - All HTTP requests logged with context
- [x] **Error Logging** - Comprehensive error tracking with stack traces
- [x] **Environment Validation** - Startup validation for required variables

### Infrastructure
- [x] **Docker Container** - Multi-stage optimized build
- [x] **Health Checks** - Endpoint monitoring at /
- [x] **CI/CD Pipeline** - GitHub Actions for automated builds
- [x] **Database Schema** - Supabase tables with RLS enabled
- [x] **Graceful Shutdown** - SIGTERM/SIGINT handlers

## 🔧 Production Deployment Steps

### 1. Environment Setup
```bash
# Create production .env file with:
SUPABASE_URL=https://rsufbrkdbpttqndqhtux.supabase.co
SUPABASE_ANON_KEY=<your_key>
OPENROUTER_API_KEY=<your_key>
SESSION_SECRET=<generate_secure_secret>
NODE_ENV=production
FRONTEND_URL_BRAIN=https://your-domain.com
```

### 2. Database Setup
```sql
-- Run setup-supabase.sql in Supabase SQL editor
-- Verify tables: brain_users, memory_nodes, memory_relationships
-- Confirm RLS policies are active
```

### 3. Docker Deployment

#### Option A: Using Docker Compose
```bash
# Pull latest image
docker compose pull brain

# Start with production environment
docker compose up -d brain

# Monitor logs
docker compose logs -f brain
```

#### Option B: Direct Docker Run
```bash
docker run -d \
  --name omi-brain \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/neooriginal/omi.me-apps/brain:latest
```

### 4. Reverse Proxy Setup
Deferred to later phase. No reverse proxy assets or configs are added in Phase 1.

### 5. Monitoring Setup
- [ ] Configure external uptime monitoring (e.g., UptimeRobot, Pingdom)
- [ ] Set up log aggregation (e.g., Datadog, LogDNA, CloudWatch)
- [ ] Configure alerting for errors and rate limit violations
- [ ] Set up application performance monitoring (APM)

## 📊 Production Readiness Verification

### Pre-Launch Checklist
- [ ] SSL/TLS certificate installed and verified
- [ ] Domain DNS configured correctly
- [ ] Firewall rules configured (only 443/80 exposed)
- [ ] Backup strategy documented and tested
- [ ] Load testing completed
- [ ] Security scan performed
- [ ] GDPR/Privacy compliance verified

### Post-Launch Monitoring
- [ ] Health endpoint responding (curl https://your-domain.com/)
- [ ] Logs being generated in /logs directory
- [ ] Rate limiting functioning correctly
- [ ] Memory usage stable over time
- [ ] Response times acceptable (<200ms p95)

## 🚨 Troubleshooting Guide

### Common Issues

#### Container Won't Start
```bash
# Check logs
docker logs omi-brain

# Verify environment variables
docker exec omi-brain env | grep -E "SUPABASE|OPENROUTER"

# Test database connection
curl -X GET "https://your-supabase-url.supabase.co/rest/v1/" \
  -H "apikey: your-anon-key"
```

#### High Memory Usage
```bash
# Check container stats
docker stats omi-brain

# Restart container
docker restart omi-brain
```

#### Rate Limiting Issues
- Check logs/combined.log for rate limit violations
- Adjust limits in server.js if needed
- Consider IP whitelisting for internal services

## 📈 Performance Optimization

### Recommended Production Settings
- **Node.js Memory**: Set `--max-old-space-size=2048` for 2GB heap
- **PM2 Cluster Mode**: Use PM2 with cluster mode for multi-core
- **CDN**: Serve static assets through CDN
- **Database Indexes**: Verify all indexes are created
- **Connection Pooling**: Supabase handles this automatically

## 🔐 Security Best Practices

1. **Regular Updates**
   - Run `npm audit` weekly
   - Update dependencies monthly
   - Monitor security advisories

2. **Secrets Management**
   - Rotate API keys quarterly
   - Use secrets management service (AWS Secrets Manager, HashiCorp Vault)
   - Never commit .env files

3. **Access Control**
   - Implement IP whitelisting if possible
   - Use VPN for admin access
   - Enable 2FA on all service accounts

## 📝 Maintenance Schedule

### Daily
- Monitor error logs
- Check health endpoint
- Review rate limit violations

### Weekly
- Analyze performance metrics
- Review security logs
- Update dependencies (if patches available)

### Monthly
- Full backup verification
- Security scan
- Performance optimization review
- Capacity planning review

## 🚀 Scaling Considerations

When traffic increases:
1. **Horizontal Scaling**: Deploy multiple containers behind load balancer
2. **Database Scaling**: Upgrade Supabase plan for more connections
3. **Caching Layer**: Implement Redis for session storage and caching
4. **CDN Integration**: Use CloudFlare or similar for static assets
5. **Queue System**: Add job queue for heavy processing tasks

## 📞 Support Contacts

- **Supabase Support**: https://supabase.com/support
- **OpenRouter Support**: https://openrouter.ai/docs
- **Docker Issues**: Check container logs first
- **Application Issues**: Review logs/error.log

---

**Last Updated**: 2025-08-09
**Version**: 1.0.0
**Status**: Production Ready with Security Enhancements