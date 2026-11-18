#!/usr/bin/env node
// Prints fresh values for the two secrets this server needs. Paste them into the Railway variables (or .env).
import { randomBytes } from 'node:crypto';
process.stdout.write(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
process.stdout.write(`ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}\n`);
