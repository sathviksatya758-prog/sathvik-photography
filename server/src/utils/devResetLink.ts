import fs from 'node:fs';
import path from 'node:path';
import { isProd, caps } from '../config/env';
import { logger } from '../lib/logger';

/** Gitignored file the link is dropped into (see server/.gitignore). */
export const DEV_LINK_FILE = path.resolve(process.cwd(), '.reset-link.txt');

/**
 * Local-development delivery fallback for account links (password reset).
 *
 * With no SMTP transport configured, sendMail() can only log — so a developer
 * who clicks "Forgot password?" gets the neutral "a link is on its way"
 * response and no way to actually obtain it. This writes the link to a
 * gitignored file instead.
 *
 * Hard-guarded on purpose:
 *   - never runs when NODE_ENV=production;
 *   - never runs when SMTP *is* configured (real mail goes out instead);
 *   - the link is only ever written to a local file — it is never included in
 *     an HTTP response, so this cannot leak a token to a caller.
 */
export function writeDevResetLink(link: string): void {
  if (isProd || caps.smtp) return;
  try {
    fs.writeFileSync(DEV_LINK_FILE, link + '\n', { encoding: 'utf8' });
    // Log the file path, never the link itself.
    logger.info({ file: DEV_LINK_FILE }, 'dev: no SMTP configured — reset link written to file');
  } catch (err) {
    logger.warn({ err }, 'dev: could not write reset link file');
  }
}
