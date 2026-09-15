App.loadInstitutionBranding();

const facultySel = document.getElementById('facultyId');
const matricNumberInput = document.getElementById('matricNumber');
const departmentInput = document.getElementById('departmentName');
const departmentOptions = document.getElementById('departmentOptions');
const levelSel = document.getElementById('levelId');
const modeSel = document.getElementById('studyModeId');
const nameInputs = ['firstName', 'lastName'].map(id => document.getElementById(id));
const studentFaculties = new Map([
  ['SCIT', 'School of Communication and Information Technology (SCIT)'],
  ['SENG', 'School of Engineering'],
  ['SENV', 'School of Environmental Studies'],
  ['SMS', 'School of Management Studies'],
  ['SPAS', 'School of Pure and Applied Sciences'],
  ['SPTS', 'School of Part-Time Studies'],
  ['SAT', 'School of Agricultural Technology'],
  ['SADP', 'School of Art, Design and Printing'],
]);

function clearRegistrationDefaults() {
  const form = document.getElementById('reg-form');
  if (!form) return;

  form.reset();
  form.querySelectorAll('input, select').forEach((field) => {
    if (field instanceof HTMLInputElement) {
      if (field.type === 'checkbox' || field.type === 'radio') field.checked = false;
      else field.value = '';
    }
    if (field instanceof HTMLSelectElement) {
      field.selectedIndex = 0;
    }
  });

  if (facultySel) facultySel.value = '';
  if (levelSel) levelSel.value = '';
  if (modeSel) modeSel.value = '';
  if (departmentInput) departmentInput.value = '';
  if (matricNumberInput) matricNumberInput.value = '';
  if (document.getElementById('email')) document.getElementById('email').value = '';
  if (document.getElementById('password')) document.getElementById('password').value = '';
  if (document.getElementById('confirmPassword')) document.getElementById('confirmPassword').value = '';
}
clearRegistrationDefaults();
window.addEventListener('pageshow', () => setTimeout(clearRegistrationDefaults, 0));
const departments = [
  'Office Technology and Management', 'Library and Information Science', 'Mass Communication', 'Music Technology', 'Multimedia Technology',
  'Agricultural & Bio-Environmental Engineering', 'Civil Engineering', 'Computer Engineering', 'Electrical/Electronic Engineering', 'Mechanical Engineering', 'Mechatronics Engineering', 'Welding and Fabrication Engineering Technology',
  'Architectural Technology', 'Building Technology', 'Estate Management and Valuation', 'Quantity Surveying', 'Surveying and Geo-informatics', 'Transportation Planning & Management Technology', 'Urban & Regional Planning',
  'Accountancy', 'Banking and Finance', 'Business Administration and Management', 'Insurance', 'Marketing', 'Public Administration', 'Taxation',
  'Computer Science', 'Food Technology', 'Hospitality Management Technology', 'Nutrition and Dietetics', 'Statistics', 'Science Laboratory Technology', 'Tourism Management Technology',
  'Agricultural Extension and Management', 'Animal Production Technology', 'Crop Production Technology', 'Agricultural Technology', 'Animal Health Production Technology', 'Horticultural Technology',
  'Art and Design — Painting', 'Art and Design — Sculpture', 'Graphic Art', 'Industrial Design — Ceramics', 'Industrial Design — Textile',
];

let visibleDepartments = [];
let activeDepartmentIndex = -1;

function selectDepartment(name) {
  departmentInput.value = name;
  departmentOptions.hidden = true;
  departmentInput.setAttribute('aria-expanded', 'false');
}

function showDepartments(query = '') {
  const normalizedQuery = query.trim().toLowerCase();
  visibleDepartments = departments.filter(name => name.toLowerCase().includes(normalizedQuery));
  activeDepartmentIndex = -1;
  departmentOptions.innerHTML = visibleDepartments.length
    ? visibleDepartments.map((name, index) => `<button type="button" class="department-option" role="option" data-index="${index}">${App.escapeHtml(name)}</button>`).join('')
    : '<div class="department-empty">No matching department</div>';
  departmentOptions.hidden = false;
  departmentInput.setAttribute('aria-expanded', 'true');
}

function setActiveDepartment(index) {
  activeDepartmentIndex = index;
  departmentOptions.querySelectorAll('.department-option').forEach((option, optionIndex) => {
    option.classList.toggle('active', optionIndex === index);
  });
}

departmentInput.addEventListener('focus', () => showDepartments(departmentInput.value));
departmentInput.addEventListener('input', () => {
  const typed = departmentInput.value;
  showDepartments(typed);
  const match = departments.find(name => name.toLowerCase().startsWith(typed.toLowerCase()));
  if (typed && match && typed.length < match.length) {
    departmentInput.value = match;
    departmentInput.setSelectionRange(typed.length, match.length);
  }
});
departmentInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (departmentOptions.hidden) showDepartments(departmentInput.value);
    setActiveDepartment(Math.min(activeDepartmentIndex + 1, visibleDepartments.length - 1));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    setActiveDepartment(Math.max(activeDepartmentIndex - 1, 0));
  } else if (event.key === 'Enter' && activeDepartmentIndex >= 0) {
    event.preventDefault();
    selectDepartment(visibleDepartments[activeDepartmentIndex]);
  } else if (event.key === 'Escape') {
    departmentOptions.hidden = true;
    departmentInput.setAttribute('aria-expanded', 'false');
  }
});
departmentOptions.addEventListener('mousedown', (event) => {
  const option = event.target.closest('.department-option');
  if (option) selectDepartment(visibleDepartments[Number(option.dataset.index)]);
});
departmentInput.addEventListener('blur', () => setTimeout(() => {
  departmentOptions.hidden = true;
  departmentInput.setAttribute('aria-expanded', 'false');
}, 150));

nameInputs.forEach(input => input.addEventListener('input', () => {
  input.value = input.value.replace(/[^\p{L}\s'-]/gu, '');
}));

document.getElementById('phone').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '');
});

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
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
    oscillator.addEventListener('ended', () => context.close());
  } catch (_) { /* Animation still provides feedback if audio is unavailable. */ }
}
bell.addEventListener('click', previewBell);
document.getElementById('enablePush').addEventListener('change', (event) => {
  if (event.target.checked) previewBell();
});

async function loadOptions() {
  const [faculties, levels, modes] = await Promise.all([
    Api.get('/api/meta/faculties'), Api.get('/api/meta/levels'), Api.get('/api/meta/study-modes'),
  ]);
  facultySel.innerHTML = '<option value="">Select faculty</option>' + faculties
    .filter(f => studentFaculties.has(f.code))
    .map(f => `<option value="${f.id}">${App.escapeHtml(studentFaculties.get(f.code))}</option>`).join('');
  levelSel.innerHTML = '<option value="">Select level</option>' + levels.map(l => `<option value="${l.id}">${App.escapeHtml(l.name)}</option>`).join('');
  modeSel.innerHTML = '<option value="">Select study mode</option>' + modes.map(m => `<option value="${m.id}">${App.escapeHtml(m.name)}</option>`).join('');
}
loadOptions().catch(App.showError);

facultySel.addEventListener('change', () => {
  if (!facultySel.value) departmentInput.value = '';
});


const form = document.getElementById('reg-form');
const alertRegion = document.getElementById('alert-region');
const btn = document.getElementById('reg-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  alertRegion.innerHTML = '';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating account…';
  try {
    const res = await Api.post('/api/auth/register/student', {
      firstName: document.getElementById('firstName').value.trim(), lastName: document.getElementById('lastName').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      matricNumber: document.getElementById('matricNumber').value.trim(), facultyId: facultySel.value, departmentName: departmentInput.value.trim(),
      levelId: levelSel.value, studyModeId: modeSel.value, email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value, confirmPassword: document.getElementById('confirmPassword').value,
      enablePush: document.getElementById('enablePush').checked,
    });
    const msg = res.message;
    alertRegion.innerHTML = `<div class="alert alert-success">${msg}</div>`;
    form.reset();
    btn.textContent = 'Account created';
  } catch (err) {
    alertRegion.innerHTML = `<div class="alert alert-error">${App.escapeHtml(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
});
