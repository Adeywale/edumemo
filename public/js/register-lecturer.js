App.loadInstitutionBranding();
const facultySel = document.getElementById('facultyId');
const departmentInput = document.getElementById('departmentName');
const departmentOptions = document.getElementById('departmentOptions');
const staffTypeInputs = document.querySelectorAll('input[name="staffType"]');
const academicDetails = document.getElementById('academic-details');
const lecturerFaculties = new Map([
  ['SCIT', 'School of Communication and Information Technology (SCIT)'], ['SENG', 'School of Engineering'], ['SENV', 'School of Environmental Studies'], ['SMS', 'School of Management Studies'], ['SPAS', 'School of Pure and Applied Sciences'], ['SPTS', 'School of Part-Time Studies'], ['SAT', 'School of Agricultural Technology'], ['SADP', 'School of Art, Design and Printing'],
]);
const departments = ['Office Technology and Management', 'Library and Information Science', 'Mass Communication', 'Music Technology', 'Multimedia Technology', 'Agricultural & Bio-Environmental Engineering', 'Civil Engineering', 'Computer Engineering', 'Electrical/Electronic Engineering', 'Mechanical Engineering', 'Mechatronics Engineering', 'Welding and Fabrication Engineering Technology', 'Architectural Technology', 'Building Technology', 'Estate Management and Valuation', 'Quantity Surveying', 'Surveying and Geo-informatics', 'Transportation Planning & Management Technology', 'Urban & Regional Planning', 'Accountancy', 'Banking and Finance', 'Business Administration and Management', 'Insurance', 'Marketing', 'Public Administration', 'Taxation', 'Computer Science', 'Food Technology', 'Hospitality Management Technology', 'Nutrition and Dietetics', 'Statistics', 'Science Laboratory Technology', 'Tourism Management Technology', 'Agricultural Extension and Management', 'Animal Production Technology', 'Crop Production Technology', 'Agricultural Technology', 'Animal Health Production Technology', 'Horticultural Technology', 'Art and Design — Painting', 'Art and Design — Sculpture', 'Graphic Art', 'Industrial Design — Ceramics', 'Industrial Design — Textile'];
let visible = [];
function selectDepartment(name) { departmentInput.value = name; departmentOptions.hidden = true; departmentInput.setAttribute('aria-expanded', 'false'); }
function showDepartments(query = '') {
  visible = departments.filter(name => name.toLowerCase().includes(query.trim().toLowerCase()));
  departmentOptions.innerHTML = visible.length ? visible.map((name, i) => `<button type="button" class="department-option" data-index="${i}">${App.escapeHtml(name)}</button>`).join('') : '<div class="department-empty">No matching department</div>';
  departmentOptions.hidden = false; departmentInput.setAttribute('aria-expanded', 'true');
}
Api.get('/api/meta/faculties').then(rows => { facultySel.innerHTML = '<option value="">Select faculty</option>' + rows.filter(row => lecturerFaculties.has(row.code)).map(row => `<option value="${row.id}">${App.escapeHtml(lecturerFaculties.get(row.code))}</option>`).join(''); }).catch(App.showError);
function updateStaffTypeFields() {
  const academic = document.querySelector('input[name="staffType"]:checked').value === 'academic';
  academicDetails.hidden = !academic;
  facultySel.required = academic;
  departmentInput.required = academic;
  if (!academic) { facultySel.value = ''; departmentInput.value = ''; }
  // Make the send/receive difference explicit before the account is created:
  // only teaching staff can ever publish memos.
  document.getElementById('staff-type-hint').textContent = academic
    ? 'Teaching staff can create, draft and publish memos to targeted students. Every staff account must be approved by an administrator before it can log in.'
    : 'Non-teaching staff can receive and read memos, but cannot create or send them. Every staff account must be approved by an administrator before it can log in.';
}
staffTypeInputs.forEach(input => input.addEventListener('change', updateStaffTypeFields));
updateStaffTypeFields();
departmentInput.addEventListener('focus', () => showDepartments(departmentInput.value));
departmentInput.addEventListener('input', () => { const typed = departmentInput.value; showDepartments(typed); const match = departments.find(name => name.toLowerCase().startsWith(typed.toLowerCase())); if (typed && match && typed.length < match.length) { departmentInput.value = match; departmentInput.setSelectionRange(typed.length, match.length); } });
departmentOptions.addEventListener('mousedown', event => { const option = event.target.closest('.department-option'); if (option) selectDepartment(visible[Number(option.dataset.index)]); });
departmentInput.addEventListener('blur', () => setTimeout(() => { departmentOptions.hidden = true; departmentInput.setAttribute('aria-expanded', 'false'); }, 150));
const bell = document.getElementById('bell-demo');
function previewBell() {
  bell.classList.remove('swing');
  void bell.offsetWidth;
  bell.classList.add('swing');
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(660, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.06, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.18);
    oscillator.addEventListener('ended', () => context.close());
  } catch (_) { /* Animation still works if audio is unavailable. */ }
}
bell.addEventListener('click', previewBell);
document.getElementById('enablePush').addEventListener('change', event => { if (event.target.checked) previewBell(); });
document.getElementById('reg-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; if (!form.checkValidity()) return form.reportValidity();
  const alertRegion = document.getElementById('alert-region'); const btn = document.getElementById('reg-btn'); alertRegion.innerHTML = ''; btn.disabled = true;
  try { const res = await Api.post('/api/auth/register/staff', { firstName: document.getElementById('firstName').value.trim(), lastName: document.getElementById('lastName').value.trim(), email: document.getElementById('email').value.trim(), phone: document.getElementById('phone').value.trim(), staffType: document.querySelector('input[name="staffType"]:checked').value, facultyId: facultySel.value, departmentName: departmentInput.value.trim(), password: document.getElementById('password').value, confirmPassword: document.getElementById('confirmPassword').value, enablePush: document.getElementById('enablePush').checked });
    const msg = res.message;
    alertRegion.innerHTML = `<div class="alert alert-success">${msg}</div>`; form.reset(); updateStaffTypeFields(); btn.textContent = 'Account created'; } catch (err) { alertRegion.innerHTML = `<div class="alert alert-error">${App.escapeHtml(err.message)}</div>`; btn.disabled = false; btn.textContent = 'Create staff account'; }
});
