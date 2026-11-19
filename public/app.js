document.addEventListener('DOMContentLoaded', () => {
  const calc = () => {
    const s = document.getElementById('calcService');
    const u = document.getElementById('calcUrgency');
    const r = document.getElementById('calcResult');
    if (s && u && r) {
      const total = Math.round(parseFloat(s.value) * parseFloat(u.value));
      r.innerHTML = `Итого: <b>${total} ₽</b>`;
    }
  };
  ['calcService', 'calcUrgency'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', calc);
  });
  calc();

  const form = document.getElementById('orderForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const res = await fetch('/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        form.reset();
        document.getElementById('orderMsg').classList.remove('d-none');
        setTimeout(() => document.getElementById('orderMsg').classList.add('d-none'), 4000);
      }
    });
  }
});
