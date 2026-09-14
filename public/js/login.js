App.loadInstitutionBranding();

const form = document.getElementById('login-form');
const alertRegion = document.getElementById('alert-region');
const btn = document.getElementById('login-btn');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) return form.reportValidity();
  alertRegion.innerHTML = '';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Accessing account…';
  try {
    const result = await Api.post('/api/auth/login', {
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
    });
    window.location.href = result.redirect || '/login.html';
  } catch (error) {
    if (error.data && error.data.emailNotVerified) {
      const emailValue = document.getElementById('email').value.trim();
      alertRegion.innerHTML = `
        <div class="alert alert-error">${App.escapeHtml(error.message)}
          <div style="margin-top:8px;">
            <button type="button" class="btn btn-secondary" id="resend-verification-btn" style="width:auto;">Resend verification email</button>
          </div>
        </div>`;
      document.getElementById('resend-verification-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const resendBtn = document.getElementById('resend-verification-btn');
        resendBtn.disabled = true;
        resendBtn.textContent = 'Sending…';
        try {
          const res = await Api.post('/api/auth/resend-verification', { email: emailValue });
          alertRegion.innerHTML = `<div class="alert alert-success">${App.escapeHtml(res.message)}</div>`;
        } catch (err) {
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend verification email';
          alertRegion.innerHTML += `<div class="alert alert-error">${App.escapeHtml(err.message)}</div>`;
        }
      });
    } else {
      alertRegion.innerHTML = `<div class="alert alert-error">${App.escapeHtml(error.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = 'Access your account';
  }
});
