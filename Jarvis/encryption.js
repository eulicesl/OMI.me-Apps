const crypto = require('crypto');

// Key management
// ENCRYPTION_KEY must be a high-entropy secret (base64 or hex). We derive a 32-byte key via HKDF.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const ENCRYPTION_KEY_PREV = process.env.ENCRYPTION_KEY_PREV || '';

function hkdfSha256(secret, salt) {
    return crypto.createHmac('sha256', salt).update(secret).digest();
}

function deriveKey(secret, salt) {
    const s = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
    const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'utf8');
    // Simple HKDF-like derivation producing 32 bytes
    return hkdfSha256(s, saltBuf).subarray(0, 32);
}

/**
 * Encrypt using AES-256-GCM with random IV and salt. Output format: v1:salt:iv:ciphertext:tag (base64)
 */
function encrypt(plainText) {
    if (!plainText) return null;
    try {
        const salt = crypto.randomBytes(16);
        const key = deriveKey(ENCRYPTION_KEY || crypto.randomBytes(32), salt);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from(String(plainText), 'utf8')),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        return [
            'v1',
            salt.toString('base64'),
            iv.toString('base64'),
            ciphertext.toString('base64'),
            tag.toString('base64')
        ].join(':');
    } catch (error) {
        console.error('Encryption error:', error);
        return null;
    }
}

/**
 * Decrypt AES-256-GCM payload produced by encrypt(). Supports key rotation via ENCRYPTION_KEY_PREV.
 */
function decrypt(payload) {
    if (!payload || typeof payload !== 'string') return null;
    try {
        const parts = payload.split(':');
        if (parts.length !== 5) return null;
        const [, saltB64, ivB64, ctB64, tagB64] = parts;
        const salt = Buffer.from(saltB64, 'base64');
        const iv = Buffer.from(ivB64, 'base64');
        const ct = Buffer.from(ctB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');

        const tryDecrypt = (secret) => {
            const key = deriveKey(secret || '', salt);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        };

        try {
            return tryDecrypt(ENCRYPTION_KEY);
        } catch (_) {
            if (ENCRYPTION_KEY_PREV) {
                return tryDecrypt(ENCRYPTION_KEY_PREV);
            }
            return null;
        }
    } catch (error) {
        console.error('Decryption error:', error);
        return null;
    }
}

/**
 * Validate OMI/OpenRouter API key formats
 * Accepts:
 * - sk_XXXXXXXX (32-64 base62) for generic providers
 * - omi_mcp_XXXXXXXX (16-64 base62/hex) for OMI MCP keys
 * - omi_XXXXXXXX (24-64 base62) for other OMI keys
 */
function validateOmiApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return false;
    const key = apiKey.trim();
    const patterns = [
        /^sk_[A-Za-z0-9]{32,64}$/,
        /^omi_mcp_[A-Za-z0-9]{16,64}$/,
        /^omi_[A-Za-z0-9]{24,64}$/
    ];
    return patterns.some(re => re.test(key));
}

module.exports = { encrypt, decrypt, validateOmiApiKey };