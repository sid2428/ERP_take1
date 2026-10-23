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
      var emptyState = el('div', null, 'empty');
      emptyState.appendChild(el('div', 'No teaching assignments were found for the current academic session.'));
      var unavailableExtraButton = el('button', 'Add extra session', 'btn primary');
      unavailableExtraButton.type = 'button';
      unavailableExtraButton.disabled = true;
      emptyState.appendChild(unavailableExtraButton);
      emptyState.appendChild(el('div', 'A teaching assignment is required before you can record an extra session.', 'muted'));
      root.appendChild(emptyState);
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
    dateInput.type = 'text';
    dateInput.readOnly = true;
    dateInput.required = true;
    dateInput.setAttribute('aria-label', 'Attendance date');
    dateInput.placeholder = 'Choose an allowed date';
    var calendar = el('div', null, 'attendance-calendar');
    dateField.append(dateLabel, dateInput, calendar);
    selectors.append(courseField, classField, dateField);
    form.appendChild(selectors);

    var toolbar = el('div', null, 'faculty-attendance-toolbar');
    var bulkButton = el('button', 'Mark all absent', 'btn small');
    bulkButton.type = 'button';
    bulkButton.disabled = true;
    var saveButton = el('button', 'Save attendance', 'btn primary');
    saveButton.type = 'button';
    saveButton.disabled = true;
    var extraButton = el('button', 'Add extra session', 'btn primary');
    extraButton.type = 'button';
    extraButton.disabled = true;
    toolbar.append(bulkButton, saveButton, extraButton);
    form.appendChild(toolbar);

    var extraReasonField = el('div', null, 'field extra-session-reason');
    var extraReasonLabel = el('label', 'Reason for extra session');
    var extraReason = el('textarea');
    extraReason.required = true;
    extraReason.maxLength = 500;
    extraReason.setAttribute('aria-label', 'Reason for extra session');
    extraReasonField.append(extraReasonLabel, extraReason);
    extraReasonField.hidden = true;
    form.appendChild(extraReasonField);

    var notice = el('div');
    notice.setAttribute('role', 'status');
    form.appendChild(notice);

    var rosterPanel = el('div', null, 'faculty-attendance-roster');
    var history = el('section', null, 'faculty-attendance-history');
    history.appendChild(el('h2', 'Past sessions'));
    history.appendChild(el('div', 'Choose a class to view its sessions.', 'empty'));
    root.append(form, rosterPanel, history);

    var courseIds = [];
    var calendarData = null;
    var attendanceSessions = [];
    var extraMode = false;
    var editingSessionId = null;
    var viewingMonth = null;
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

    function parseDate(value) {
      var parts = value.split('-').map(Number);
      return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    }

    function dateString(date) {
      return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0')
        + '-' + String(date.getUTCDate()).padStart(2, '0');
    }

    function isAllowedDate(value) {
      if (!calendarData || value < calendarData.term_start || value > calendarData.today
        || value > calendarData.term_end) return false;
      var editingSession = attendanceSessions.find(function (session) {
        return session.session_id === editingSessionId;
      });
      if (extraMode || (editingSession && editingSession.is_extra)) return true;
      var weekday = parseDate(value).getUTCDay() || 7;
      return calendarData.allowed_weekdays.indexOf(weekday) !== -1;
    }

    function renderCalendar() {
      if (!calendarData) return;
      if (!viewingMonth) viewingMonth = parseDate(dateInput.value || calendarData.today);
      calendar.replaceChildren();
      var navigation = el('div', null, 'attendance-calendar-nav');
      var previous = el('button', 'Previous month', 'btn small');
      previous.type = 'button';
      previous.setAttribute('aria-label', 'Previous month');
      var monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(viewingMonth);
      var next = el('button', 'Next month', 'btn small');
      next.type = 'button';
      next.setAttribute('aria-label', 'Next month');
      navigation.append(previous, el('strong', monthName), next);
      previous.disabled = dateString(new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth(), 1)))
        <= calendarData.term_start.slice(0, 7) + '-01';
      var lastDate = dateString(new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth() + 1, 0)));
      next.disabled = lastDate >= calendarData.today.slice(0, 7) + '-31'
        || dateString(new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth() + 1, 1)))
          > calendarData.term_end;
      previous.addEventListener('click', function () {
        viewingMonth = new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth() - 1, 1));
        renderCalendar();
      });
      next.addEventListener('click', function () {
        viewingMonth = new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth() + 1, 1));
        renderCalendar();
      });
      calendar.appendChild(navigation);

      var grid = el('div', null, 'attendance-calendar-grid');
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (day) {
        grid.appendChild(el('span', day, 'attendance-calendar-weekday'));
      });
      var firstDay = new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth(), 1));
      var offset = (firstDay.getUTCDay() + 6) % 7;
      for (var blank = 0; blank < offset; blank += 1) grid.appendChild(el('span', ''));
      var daysInMonth = new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth() + 1, 0)).getUTCDate();
      for (var dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
        var value = dateString(new Date(Date.UTC(viewingMonth.getUTCFullYear(), viewingMonth.getUTCMonth(), dayNumber)));
        var dayButton = el('button', dayNumber, 'attendance-calendar-day');
        dayButton.type = 'button';
        dayButton.disabled = !isAllowedDate(value);
        dayButton.setAttribute('aria-label', value);
        if (value === dateInput.value) dayButton.classList.add('selected');
        if (!dayButton.disabled) {
          dayButton.addEventListener('click', function (selectedValue) {
            return function () {
              editingSessionId = null;
              dateInput.value = selectedValue;
              viewingMonth = parseDate(selectedValue);
              renderCalendar();
              notice.textContent = '';
              loadRoster();
            };
          }(value));
        }
        grid.appendChild(dayButton);
      }
      calendar.appendChild(grid);
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
      var currentSession = attendanceSessions.find(function (session) {
        return session.session_id === editingSessionId;
      }) || attendanceSessions.find(function (session) {
        return !session.is_extra && session.session_date === dateInput.value;
      });
      saveButton.disabled = Boolean(data.is_locked || (currentSession && currentSession.is_locked));
      if (saveButton.disabled) {
        rosterPanel.appendChild(el('div', '🔒 This session is locked. Request an admin unlock from Past sessions.', 'empty'));
      }
      updateBulkButton();
    }

    function loadRoster() {
      var assignment = selectedAssignment();
      if (!assignment || !dateInput.value) return;
      if (!isAllowedDate(dateInput.value)) {
        rosterPanel.replaceChildren(el('div', extraMode
          ? 'Choose a date within the term that is not in the future.'
          : 'Choose a scheduled weekday to mark attendance.', 'empty'));
        saveButton.disabled = true;
        bulkButton.disabled = true;
        return;
      }
      rosterPanel.replaceChildren(el('div', 'Loading class roster…', 'student-state'));
      saveButton.disabled = true;
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/roster?date='
        + encodeURIComponent(dateInput.value)
        + (editingSessionId ? '&session_id=' + encodeURIComponent(editingSessionId) : ''))
        .then(renderRoster)
        .catch(function (error) { showError(rosterPanel, error); });
    }

    function renderHistory(sessions) {
      attendanceSessions = sessions;
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
        var dateText = session.session_date + (session.is_locked ? ' · 🔒 Locked' : '');
        if (session.is_extra) dateText += ' · Extra session: ' + session.reason;
        if (session.unlock_status === 'pending') dateText += ' · Unlock request pending';
        if (session.unlock_status === 'rejected') dateText += ' · Unlock request rejected';
        if (session.unlock_status === 'approved') {
          var expiry = new Date(session.unlock_expires_at);
          dateText += ' · Approved until ' + new Intl.DateTimeFormat('en-IN', {
            day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
            timeZone: 'Asia/Kolkata',
          }).format(expiry);
        }
        row.appendChild(el('td', dateText));
        row.appendChild(el('td', session.present_count));
        row.appendChild(el('td', session.absent_count));
        var cell = el('td');
        if (!session.is_locked) {
          var edit = el('button', 'Edit', 'btn small');
          edit.type = 'button';
          edit.addEventListener('click', function () {
            editingSessionId = session.session_id;
            dateInput.value = session.session_date;
            viewingMonth = parseDate(session.session_date);
            renderCalendar();
            loadRoster();
            rosterPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          cell.appendChild(edit);
        }
        if (session.is_locked && session.unlock_status !== 'pending') {
          var requestButton = el('button', 'Request unlock', 'btn small');
          requestButton.type = 'button';
          var requestPanel = el('div', null, 'field');
          var reason = el('textarea');
          reason.required = true;
          reason.maxLength = 500;
          reason.placeholder = 'Reason for requesting an unlock';
          reason.setAttribute('aria-label', 'Reason for requesting an attendance unlock');
          var submitRequest = el('button', 'Submit request', 'btn primary small');
          submitRequest.type = 'button';
          requestPanel.hidden = true;
          requestPanel.append(reason, submitRequest);
          requestButton.addEventListener('click', function () {
            requestPanel.hidden = !requestPanel.hidden;
            if (!requestPanel.hidden) reason.focus();
          });
          submitRequest.addEventListener('click', function () {
            if (!reason.value.trim()) {
              reason.focus();
              return;
            }
            submitRequest.disabled = true;
            fetchJson('/faculty/attendance/assignments/' + selectedAssignment().assignment_id
              + '/sessions/' + session.session_id + '/unlock-requests', {
              method: 'POST',
              headers: {
                Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': csrfToken,
              },
              body: new URLSearchParams({ _csrf: csrfToken, reason: reason.value.trim() }).toString(),
            }).then(function () {
              fetchJson('/faculty/attendance/assignments/' + selectedAssignment().assignment_id + '/sessions')
                .then(function (data) { renderHistory(data.sessions); })
                .catch(function (error) { showError(history, error); });
            }).catch(function (error) {
              showError(requestPanel, error);
              submitRequest.disabled = false;
            });
          });
          cell.append(requestButton, requestPanel);
        }
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
      extraButton.disabled = !assignment;
      if (!assignment) {
        calendarData = null;
        calendar.replaceChildren();
        dateInput.value = '';
        history.replaceChildren(el('h2', 'Past sessions'), el('div', 'Choose a class to view its sessions.', 'empty'));
        return;
      }
      history.replaceChildren(el('h2', 'Past sessions'), el('div', 'Loading past sessions…', 'student-state'));
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/sessions')
        .then(function (data) { renderHistory(data.sessions); })
        .catch(function (error) { showError(history, error); });
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id + '/calendar')
        .then(function (data) {
          calendarData = data.calendar;
          var latest = calendarData.today < calendarData.term_end ? calendarData.today : calendarData.term_end;
          var selected = dateInput.value;
          if (!selected || selected < calendarData.term_start || selected > latest || !isAllowedDate(selected)) {
            selected = '';
            for (var stamp = parseDate(latest).getTime(); stamp >= parseDate(calendarData.term_start).getTime();
              stamp -= 86400000) {
              var candidate = dateString(new Date(stamp));
              if (isAllowedDate(candidate)) {
                selected = candidate;
                break;
              }
            }
          }
          dateInput.value = selected;
          viewingMonth = parseDate(selected || calendarData.term_start);
          renderCalendar();
          if (selected) loadRoster();
          else {
            rosterPanel.replaceChildren(el('div', 'There are no allowed dates in this term yet.', 'empty'));
            saveButton.disabled = true;
          }
        })
        .catch(function (error) { showError(rosterPanel, error); });
    }

    bulkButton.addEventListener('click', function () {
      var checks = rosterPanel.querySelectorAll('input[name="present"]');
      var makePresent = Array.prototype.some.call(checks, function (checkbox) { return !checkbox.checked; });
      checks.forEach(function (checkbox) {
        checkbox.checked = makePresent;
        checkbox.dispatchEvent(new Event('change'));
      });
    });

    extraButton.addEventListener('click', function () {
      editingSessionId = null;
      extraMode = !extraMode;
      extraReasonField.hidden = !extraMode;
      extraButton.textContent = extraMode ? 'Cancel extra session' : 'Add extra session';
      saveButton.textContent = extraMode ? 'Save extra session' : 'Save attendance';
      extraReason.value = '';
      renderCalendar();
      loadRoster();
    });

    saveButton.addEventListener('click', function () {
      var assignment = selectedAssignment();
      if (!assignment || !dateInput.value) return;
      if (!isAllowedDate(dateInput.value)) {
        notice.className = 'flash error';
        notice.textContent = extraMode
          ? 'Choose a date within the term that is not in the future.'
          : 'Choose a scheduled weekday to mark attendance.';
        return;
      }
      if (extraMode && !extraReason.value.trim()) {
        notice.className = 'flash error';
        notice.textContent = 'Enter a reason before saving an extra session.';
        extraReason.focus();
        return;
      }
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
      if (editingSessionId) body.set('session_id', String(editingSessionId));
      if (extraMode) body.set('reason', extraReason.value.trim());
      fetchJson('/faculty/attendance/assignments/' + assignment.assignment_id
        + (extraMode ? '/extra-sessions' : '/sessions'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrfToken },
        body: body.toString(),
      }).then(function (result) {
        notice.className = 'flash success';
        notice.textContent = result.message + ' Student attendance summaries are updated.';
        if (extraMode) {
          extraMode = false;
          extraReasonField.hidden = true;
          extraButton.textContent = 'Add extra session';
          saveButton.textContent = 'Save attendance';
          extraReason.value = '';
          renderCalendar();
        }
        editingSessionId = null;
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

    courseSelect.addEventListener('change', function () {
      editingSessionId = null;
      renderClasses();
    });
    classSelect.addEventListener('change', function () {
      editingSessionId = null;
      loadClass();
    });
    renderClasses();
  }

  fetchJson('/faculty/attendance/assignments').then(setup).catch(function (error) {
    showError(root, error);
  });
})();
