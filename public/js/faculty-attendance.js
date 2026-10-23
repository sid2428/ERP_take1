(function () {
  'use strict';

  var root = document.querySelector('[data-faculty-attendance]');
  if (!root) return;

  var assignments = [];
  var csrf = document.querySelector('input[name="_csrf"]');
  var csrfToken = csrf ? csrf.value : '';

  function el(tag, text, className) {
    var item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  }

  function fetchJson(url, options) {
    var config = Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, options || {});
    return fetch(url, config).then(function (response) {
      if (response.redirected) throw new Error('Your session has expired. Sign in again to continue.');
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
        return data;
      });
    });
  }

  function showError(target, error) {
    target.replaceChildren(el('div', error && error.message ? error.message : 'Could not load attendance.', 'flash error'));
  }

  function setup(data) {
    assignments = data.assignments;
    root.replaceChildren();
    if (!assignments.length) {
      root.appendChild(el('div', 'No teaching assignments were found for the current academic session.', 'empty'));
      return;
    }

    var form = el('div', null, 'faculty-attendance-form');
    var selectors = el('div', null, 'form-grid');
    var courseField = el('div', null, 'field');
    var courseLabel = el('label', 'Course');
    var courseSelect = el('select');
    courseSelect.setAttribute('aria-label', 'Choose a course');
    courseField.append(courseLabel, courseSelect);

    var classField = el('div', null, 'field');
    var classLabel = el('label', 'Division / batch');
    var classSelect = el('select');
    classSelect.setAttribute('aria-label', 'Choose a division or batch');
    classField.append(classLabel, classSelect);

    var dateField = el('div', null, 'field');
    var dateLabel = el('label', 'Attendance date');
    var dateInput = el('input');
    dateInput.type = 'date';
    dateInput.required = true;
    dateInput.setAttribute('aria-label', 'Attendance date');
    dateField.append(dateLabel, dateInput);
    selectors.append(courseField, classField, dateField);
    form.appendChild(selectors);

    var toolbar = el('div', null, 'faculty-attendance-toolbar');
    var bulkButton = el('button', 'Mark all absent', 'btn small');
    bulkButton.type = 'button';
    bulkButton.disabled = true;
    var saveButton = el('button', 'Save attendance', 'btn primary');
    saveButton.type = 'button';
    saveButton.disabled = true;
    toolbar.append(bulkButton, saveButton);
    form.appendChild(toolbar);

    var notice = el('div');
    notice.setAttribute('role', 'status');
    form.appendChild(notice);

    var rosterPanel = el('div', null, 'faculty-attendance-roster');
    var history = el('section', null, 'faculty-attendance-history');
    history.appendChild(el('h2', 'Past sessions'));
    history.appendChild(el('div', 'Choose a class to view its sessions.', 'empty'));
    root.append(form, rosterPanel, history);

    var courseIds = [];
    assignments.forEach(function (assignment) {
      if (courseIds.indexOf(assignment.course_id) === -1) courseIds.push(assignment.course_id);
    });
    courseIds.forEach(function (courseId) {
      var assignment = assignments.find(function (item) { return item.course_id === courseId; });
      var option = el('option', assignment.course_code + ' · ' + assignment.course_name);
      option.value = courseId;
      courseSelect.appendChild(option);
    });

    function selectedAssignment() {
      return assignments.find(function (assignment) {
        return String(assignment.assignment_id) === classSelect.value;
      });
    }

    function renderClasses() {
      classSelect.replaceChildren();
      var candidates = assignments.filter(function (assignment) {
        return String(assignment.course_id) === courseSelect.value;
      });
      candidates.forEach(function (assignment) {
        var label = assignment.class_label;
        if (assignment.batch_code) label += ' · ' + assignment.batch_code;
        if (!assignment.division_id && !assignment.batch_id) label += ' · ' + assignment.session_type;
        var option = el('option', label + ' · ' + assignment.students + ' students');
        option.value = assignment.assignment_id;
        classSelect.appendChild(option);
      });
      loadClass();
    }

    function clampDate(assignment) {
      dateInput.min = assignment.term_start;
      dateInput.max = assignment.term_end;
      var today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      dateInput.value = today < assignment.term_start ? assignment.term_start
        : today > assignment.term_end ? assignment.term_end : today;
    }

    function updateBulkButton() {
      var checks = rosterPanel.querySelectorAll('input[name="present"]');
      var allPresent = Array.prototype.every.call(checks, function (checkbox) { return checkbox.checked; });
      bulkButton.textContent = allPresent ? 'Mark all absent' : 'Mark all present';
      bulkButton.disabled = checks.length === 0;
    }

    function renderRoster(data) {
      rosterPanel.replaceChildren();
      var header = el('div', null, 'hd');
      header.appendChild(el('h2', data.assignment.course_code + ' · ' + data.assignment.class_label
        + (data.assignment.batch_code ? ' · ' + data.assignment.batch_code : '')));
      header.appendChild(el('span', data.students.length + ' students', 'muted'));
      rosterPanel.appendChild(header);
      if (!data.students.length) {
        rosterPanel.appendChild(el('div', 'No students are enrolled in this class.', 'empty'));
        saveButton.disabled = true;
        bulkButton.disabled = true;
        return;
      }

      var table = el('table');
      var head = el('thead');
      var headerRow = el('tr');
      ['Roll', 'Student number', 'Student', 'Present'].forEach(function (name) {
        headerRow.appendChild(el('th', name));
      });
      head.appendChild(headerRow);
      var body = el('tbody');
      data.students.forEach(function (student) {
        var row = el('tr');
        row.appendChild(el('td', student.roll_no === null ? '—' : student.roll_no));
        row.appendChild(el('td', student.student_number, 'code'));
        row.appendChild(el('td', student.name));
        var cell = el('td');
        var label = el('label', null, 'attendance-check');
        var checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'present';
        checkbox.value = student.student_id;
        checkbox.checked = student.status !== 'A';
        checkbox.setAttribute('aria-label', student.name + ' present');
        label.append(checkbox, el('span', checkbox.checked ? 'Present' : 'Absent'));
        checkbox.addEventListener('change', function () {
          label.querySelector('span').textContent = checkbox.checked ? 'Present' : 'Absent';
          updateBulkButton();
        });
        cell.appendChild(label);
        row.appendChild(cell);
        body.appendChild(row);
      });
      table.append(head, body);
      var wrapper = el('div', null, 'sc');
      wrapper.appendChild(table);
      rosterPanel.appendChild(wrapper);
      saveButton.disabled = false;
      updateBulkButton();
    }

    function loadRoster() {
      var assignment = selectedAssignment();
      if (!assignment || !dateInput.value) return;
      rosterPanel.replaceChildren(el('div', 'Loading class roster…', 'student-state'));
      saveButton.disabled = true;
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/roster?date='
        + encodeURIComponent(dateInput.value))
        .then(renderRoster)
        .catch(function (error) { showError(rosterPanel, error); });
    }

    function renderHistory(sessions) {
      history.replaceChildren(el('h2', 'Past sessions'));
      if (!sessions.length) {
        history.appendChild(el('div', 'No attendance sessions have been recorded for this class.', 'empty'));
        return;
      }
      var table = el('table');
      var head = el('thead');
      var headerRow = el('tr');
      ['Date', 'Present', 'Absent', ''].forEach(function (name) { headerRow.appendChild(el('th', name)); });
      head.appendChild(headerRow);
      var body = el('tbody');
      sessions.forEach(function (session) {
        var row = el('tr');
        row.appendChild(el('td', session.session_date));
        row.appendChild(el('td', session.present_count));
        row.appendChild(el('td', session.absent_count));
        var cell = el('td');
        var edit = el('button', 'Edit', 'btn small');
        edit.type = 'button';
        edit.addEventListener('click', function () {
          dateInput.value = session.session_date;
          loadRoster();
          rosterPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        cell.appendChild(edit);
        row.appendChild(cell);
        body.appendChild(row);
      });
      table.append(head, body);
      var wrapper = el('div', null, 'sc');
      wrapper.appendChild(table);
      history.appendChild(wrapper);
    }

    function loadClass() {
      var assignment = selectedAssignment();
      notice.textContent = '';
      rosterPanel.replaceChildren();
      saveButton.disabled = true;
      if (!assignment) {
        history.replaceChildren(el('h2', 'Past sessions'), el('div', 'Choose a class to view its sessions.', 'empty'));
        return;
      }
      clampDate(assignment);
      history.replaceChildren(el('h2', 'Past sessions'), el('div', 'Loading past sessions…', 'student-state'));
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/sessions')
        .then(function (data) { renderHistory(data.sessions); })
        .catch(function (error) { showError(history, error); });
      loadRoster();
    }

    bulkButton.addEventListener('click', function () {
      var checks = rosterPanel.querySelectorAll('input[name="present"]');
      var makePresent = Array.prototype.some.call(checks, function (checkbox) { return !checkbox.checked; });
      checks.forEach(function (checkbox) {
        checkbox.checked = makePresent;
        checkbox.dispatchEvent(new Event('change'));
      });
    });

    saveButton.addEventListener('click', function () {
      var assignment = selectedAssignment();
      if (!assignment || !dateInput.value) return;
      var absentIds = Array.prototype.map.call(rosterPanel.querySelectorAll('input[name="present"]:not(:checked)'), function (input) {
        return Number(input.value);
      });
      saveButton.disabled = true;
      notice.className = 'student-state';
      notice.textContent = 'Saving attendance…';
      var body = new URLSearchParams({
        _csrf: csrfToken,
        session_date: dateInput.value,
        absent_student_ids: JSON.stringify(absentIds),
      });
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/sessions', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrfToken },
        body: body.toString(),
      }).then(function (result) {
        notice.className = 'flash success';
        notice.textContent = result.message + ' Student attendance summaries are updated.';
        loadRoster();
        fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/sessions')
          .then(function (data) { renderHistory(data.sessions); })
          .catch(function (error) { showError(history, error); });
      }).catch(function (error) {
        notice.className = 'flash error';
        notice.textContent = error.message || 'Attendance could not be saved.';
        saveButton.disabled = false;
      });
    });

    courseSelect.addEventListener('change', renderClasses);
    classSelect.addEventListener('change', loadClass);
    dateInput.addEventListener('change', loadRoster);
    renderClasses();
  }

  fetchJson('/faculty/attendance/assignments').then(setup).catch(function (error) {
    showError(root, error);
  });
})();
