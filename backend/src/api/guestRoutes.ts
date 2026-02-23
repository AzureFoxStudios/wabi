/**
 * Guest Routes
 * 
 * Handles guest access verification.
 * Guests can access the chat with a verified access code.
 */

import { guestCodeRepository } from '../db/repositories/guestCodeRepository.js';

export async function handleVerifyGuestCode(req: any, res: any): Promise<void> {
  let body = '';
  
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      const { code } = JSON.parse(body);

      if (!code || typeof code !== 'string') {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: false, error: 'Code required' }));
        return;
      }

      const isValid = guestCodeRepository.isValidCode(code);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        valid: isValid,
        message: isValid ? 'Code verified' : 'Invalid code'
      }));
    } catch (error) {
      console.error('Guest code verification error:', error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, error: 'Verification failed' }));
    }
  });
}
