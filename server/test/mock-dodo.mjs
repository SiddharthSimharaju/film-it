// A stand-in for the Dodo API on port 8799, for local tests only (see test/dev.vars.example: DODO_BASE=http://localhost:8799).
// Any subscription id that starts with "sub_dev" exists and is active, which is what the Worker's dev-only /dev/grant route creates.
import http from 'node:http';
const subs = {};
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer dummy_local_key') return send({ error: 'auth' }, 401);
    let m;
    if (req.method === 'POST' && req.url === '/checkouts') return send({ session_id: 'cks_mock', checkout_url: 'https://test.checkout.dodopayments.com/session/cks_mock' });
    if ((m = req.url.match(/^\/subscriptions\/(sub_dev[\w-]*)$/))) {
      const s = subs[m[1]] ||= { subscription_id: m[1], product_id: 'pdt_mock', status: 'active', next_billing_date: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_next_billing_date: false };
      if (req.method === 'PATCH') Object.assign(s, JSON.parse(body)); return send(s);
    }
    if (req.url.startsWith('/invoices/payments/')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 mock invoice'); }
    if (/^\/customers\/[\w-]+\/customer-portal\/session$/.test(req.url)) return send({ link: 'https://test.customer.dodopayments.com/p/mock' });
    send({}, 404);
  });
}).listen(8799, () => console.log('mock Dodo on :8799'));
