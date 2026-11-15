const dateFormat = new Intl.DateTimeFormat('he-IL', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jerusalem'
});

const branches = { rehovot: 'רחובות', modiin: 'מודיעין' };
const statuses = { cancelled: 'בוטל', pending: 'ממתין לאישור' };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderCustomer(customer, open) {
  const details = node('details', '', 'customer-history-result');
  details.open = open;
  const summary = node('summary', customer.name);
  if (customer.phoneLastFour) summary.append(node('small', 'טלפון מסתיים ב־' + customer.phoneLastFour));
  details.append(summary);
  const list = node('ol');
  for (const appt of customer.appointments) {
    const item = node('li');
    item.append(node('strong', appt.services || 'לא נרשם טיפול'));
    const time = node('time', dateFormat.format(appt.time));
    time.dateTime = new Date(appt.time).toISOString();
    const meta = node('div', '', 'customer-history-meta');
    meta.append(time);
    if (branches[appt.branch]) meta.append(node('span', branches[appt.branch]));
    if (statuses[appt.status]) meta.append(node('span', statuses[appt.status], 'customer-history-status'));
    item.append(meta);
    list.append(item);
  }
  details.append(list);
  return details;
}

export function mountCustomerHistory() {
  const page = document.getElementById('screen-mirit-appts');
  const heading = page?.querySelector('.section-title');
  if (!heading || !window._auth || !window._onAuthStateChanged) return;

  const section = node('section', '', 'customer-history');
  section.hidden = true;
  const style = node('style', `
    .customer-history{margin:0 24px 16px;background:var(--white);border:1px solid var(--line);border-radius:14px;padding:14px}
    .customer-history label{font-weight:650;color:var(--ink)}
    .customer-history-form{display:flex;gap:8px;margin:7px 0 0}
    .customer-history-form .input{width:100%;min-width:0;padding:10px 12px}
    .customer-history-form .btn{width:auto;padding:8px 16px;background:var(--ink);color:var(--white);font-size:14px}
    .customer-history-message{color:var(--ink-soft);font-size:13px;margin:10px 0 0}
    .customer-history-message:empty{display:none}
    .customer-history-result{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}
    .customer-history-result summary{cursor:pointer;font-weight:650;overflow-wrap:anywhere}
    .customer-history-result small{color:var(--ink-soft);font-weight:400;margin-inline-start:8px}
    .customer-history-result ol{list-style:none;margin:8px 0 0;padding:0;padding-inline-start:12px;border-inline-start:2px solid var(--rose-blush)}
    .customer-history-result li{padding:8px 0;overflow-wrap:anywhere}
    .customer-history-meta{display:flex;flex-wrap:wrap;gap:2px 10px;color:var(--ink-soft);font-size:13px}
    .customer-history-status{font-weight:650}
  `);
  const label = node('label', 'היסטוריית לקוחה');
  const form = node('form', '', 'customer-history-form');
  const input = node('input', '', 'input');
  input.id = 'customer-history-search';
  input.type = 'search';
  input.placeholder = 'שם לקוחה';
  input.maxLength = 100;
  input.minLength = 2;
  input.required = true;
  label.htmlFor = input.id;
  const button = node('button', 'חפשי', 'btn');
  button.type = 'submit';
  const message = node('p', '', 'customer-history-message');
  message.setAttribute('role', 'status');
  const results = node('div');
  form.append(input, button);
  section.append(label, form, message, results);
  document.head.append(style);
  heading.after(section);

  let authVersion = 0;
  window._onAuthStateChanged(window._auth, async user => {
    const version = ++authVersion;
    section.hidden = true;
    input.value = '';
    button.disabled = false;
    message.textContent = '';
    results.replaceChildren();
    const token = user ? await user.getIdTokenResult().catch(() => null) : null;
    if (authVersion === version && token?.claims.admin === true) section.hidden = false;
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (section.hidden || button.disabled) return;
    const version = authVersion;
    const name = input.value.trim();
    results.replaceChildren();
    if (name.length < 2) {
      message.textContent = 'הזיני לפחות שתי אותיות מהשם.';
      return;
    }
    button.disabled = true;
    message.textContent = 'מחפשת…';
    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js'
      );
      const functions = getFunctions(window._auth.app, 'europe-west1');
      const search = httpsCallable(functions, 'searchCustomerHistory');
      const { data } = await search({ name });
      if (authVersion !== version) return;
      message.textContent = data.hasMore ? 'יש תוצאות נוספות. הזיני שם מדויק יותר.'
        : data.customers.length ? '' : 'לא נמצאו תורים קודמים לשם הזה.';
      results.append(...data.customers.map(customer => renderCustomer(customer, data.customers.length === 1)));
    } catch (error) {
      if (authVersion !== version) return;
      message.textContent = error.code === 'functions/invalid-argument' ? 'הזיני לפחות שתי אותיות מהשם.'
        : 'לא הצלחנו לטעון את ההיסטוריה. נסי שוב.';
    } finally {
      if (authVersion === version) button.disabled = false;
    }
  });
}
