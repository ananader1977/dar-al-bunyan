// Online invoice payment: a built-in DEMO checkout (default) or Stripe Checkout (real cards, AED).
// Switch with PAYMENT_PROVIDER=stripe + STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET.
import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { safeEqual } from './auth.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const payUrl = (base, inv) => `${base}/pay.html?inv=${encodeURIComponent(inv.number)}&t=${inv.pay_token}`;

export function createPayments(ctx) {
  return ctx.config.paymentProvider === 'stripe' ? stripeProvider(ctx) : mockProvider(ctx);
}

function mockProvider(ctx) {
  const { db, config } = ctx;
  return {
    name: 'mock',
    async createCheckout(inv) {
      const id = `demo_${crypto.randomBytes(9).toString('hex')}`;
      db.prepare('INSERT INTO payment_sessions(id,invoice_id,provider,status,amount,created_at) VALUES(?,?,?,?,?,?)').run(id, inv.id, 'mock', 'open', inv.total, ctx.now());
      return { id, url: `${config.baseUrl}/pay-demo.html?s=${id}&inv=${encodeURIComponent(inv.number)}&t=${inv.pay_token}` };
    },
    async retrieve(sessionId) {
      const s = db.prepare('SELECT * FROM payment_sessions WHERE id=?').get(sessionId);
      if (!s) return { paid: false };
      return { paid: s.status === 'paid', paymentRef: s.payment_ref };
    },
    /** Demo only: the payer presses "Pay" on the demo checkout page. */
    completeMock(sessionId) {
      const s = db.prepare('SELECT * FROM payment_sessions WHERE id=?').get(sessionId);
      if (!s || s.provider !== 'mock') throw new HttpError(404, 'Payment session not found');
      const ref = s.payment_ref || `demo_pi_${crypto.randomBytes(8).toString('hex')}`;
      db.prepare("UPDATE payment_sessions SET status='paid', payment_ref=? WHERE id=?").run(ref, sessionId);
      return { invoiceId: s.invoice_id, paymentRef: ref };
    },
    payUrl: (inv) => payUrl(config.baseUrl, inv),
  };
}

function stripeProvider(ctx) {
  const { db, config } = ctx;
  const call = async (method, path, params) => {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.stripe.secretKey}`, ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: params ? new URLSearchParams(params).toString() : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Stripe: ${data?.error?.message || res.status}`);
    return data;
  };
  return {
    name: 'stripe',
    async createCheckout(inv) {
      const back = payUrl(config.baseUrl, inv);
      const data = await call('POST', '/checkout/sessions', {
        mode: 'payment',
        'payment_method_types[0]': 'card',
        success_url: `${back}&done=1`,
        cancel_url: back,
        ...(inv.client_email ? { customer_email: inv.client_email } : {}),
        client_reference_id: String(inv.id),
        'metadata[invoice_id]': String(inv.id),
        'metadata[invoice_number]': inv.number,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'aed',
        'line_items[0][price_data][unit_amount]': String(Math.round(inv.total * 100)),
        'line_items[0][price_data][product_data][name]': `Invoice ${inv.number}`,
      });
      db.prepare('INSERT INTO payment_sessions(id,invoice_id,provider,status,amount,created_at) VALUES(?,?,?,?,?,?)').run(data.id, inv.id, 'stripe', 'open', inv.total, ctx.now());
      return { id: data.id, url: data.url };
    },
    async retrieve(sessionId) {
      const s = await call('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      return { paid: s.payment_status === 'paid', paymentRef: s.payment_intent || s.id };
    },
    verifyWebhook(rawBody, header) {
      const secret = config.stripe.webhookSecret;
      if (!secret) throw new HttpError(400, 'Webhook secret not configured');
      const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
      if (!parts.t || !parts.v1) throw new HttpError(400, 'Bad signature header');
      const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
      if (!safeEqual(expected, parts.v1)) throw new HttpError(400, 'Invalid signature');
      if (Math.abs(ctx.now() / 1000 - Number(parts.t)) > 300) throw new HttpError(400, 'Signature timestamp too old');
      return JSON.parse(rawBody.toString('utf8'));
    },
    payUrl: (inv) => payUrl(config.baseUrl, inv),
  };
}
