import nodemailer from 'nodemailer';
import { config } from '../config';

export interface MailMessage { to: string; subject: string; text: string; messageId: string }
export interface Mailer { send(m: MailMessage): Promise<void> }

export class SmtpMailer implements Mailer {
  private t = config.smtp.host
    ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined })
    : nodemailer.createTransport({ jsonTransport: true }); // dev: no SMTP configured -> log instead of send
  async send(m: MailMessage) {
    await this.t.sendMail({ from: config.smtp.from, to: m.to, subject: m.subject, text: m.text, messageId: m.messageId });
    if (!config.smtp.host) console.log('[mail:dev]', m.to, '|', m.subject);
  }
}
