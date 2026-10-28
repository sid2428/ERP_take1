(function () {
  'use strict';

  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-print-ticket]')) window.print();
  });

  var view = document.querySelector('[data-student-view]');
  if (!view) return;

  var mode = view.getAttribute('data-student-view');
  var PAGE_SIZE = 25;

  function node(tag, text, className) {
    var el = document.createElement(tag);
    if (text !== undefined && text !== null) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }

  function date(value) {
    if (!value) return '—';
    var parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00Z') : new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    }).format(parsed);
  }

  function time(value) {
    if (!value) return '—';
    var parts = value.split(':');
    var hour = Number(parts[0]);
    var minute = parts[1] || '00';
    return ((hour + 11) % 12 + 1) + ':' + minute + (hour < 12 ? ' AM' : ' PM');
  }

  function showError(error) {
    var message = error && error.message ? error.message : 'Could not load your records. Please try again.';
    view.replaceChildren(node('div', message, 'flash error'));
  }

  function requestJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
      if (response.redirected) throw new Error('Your session has expired. Sign in again to view your records.');
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Could not load your records.');
        return body;
      });
    });
  }

  function clearView() {
    view.replaceChildren();
  }

  function empty(message) {
    return node('div', message, 'empty');
  }

  function table(headers, rows) {
    var wrapper = node('div', null, 'sc');
    var tableEl = node('table');
    var thead = node('thead');
    var headRow = node('tr');
    headers.forEach(function (label) { headRow.appendChild(node('th', label)); });
    thead.appendChild(headRow);
    var tbody = node('tbody');
    rows.forEach(function (cells) {
      var row = node('tr');
      cells.forEach(function (cell) {
        var td = node('td');
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell === null || cell === undefined || cell === '' ? '—' : String(cell);
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    tableEl.append(thead, tbody);
    wrapper.appendChild(tableEl);
    return wrapper;
  }

  function pct(value) {
    return value === null || value === undefined ? '—' : Number(value).toFixed(1) + '%';
  }

  function courseType(value) {
    if (value === 'TH') return 'Theory';
    if (value === 'LAB') return 'Lab';
    return 'Tutorial';
  }

  function componentMark(value, maximum) {
    if (Number(maximum) <= 0) return '—';
    return (value === null || value === undefined ? '—' : value) + ' / ' + maximum;
  }

  function attendanceBar(value) {
    var box = node('div', null, 'student-pct');
    var label = node('b', pct(value));
    var bar = node('div', null, 'bar');
    var fill = node('i');
    var numericValue = value === null || value === undefined ? null : Number(value);
    var safePct = numericValue === null ? 0 : Math.max(0, Math.min(100, numericValue));
    if (value !== null && value !== undefined) {
      fill.className = numericValue < 75 ? 'bad' : numericValue < 80 ? 'warn' : '';
      fill.style.width = safePct + '%';
    }
    bar.append(fill);
    box.append(label, bar);
    return box;
  }

  function attendanceEligibility(value) {
    if (value === null || value === undefined) return node('span', 'Not available', 'pill n');
    return value >= 75
      ? node('span', 'Eligible', 'pill g')
      : node('span', 'Below 75%', 'pill r');
  }

  function examEligibility(exam) {
    var registered = exam.registration_status === 'Registered';
    var attendance = Number(exam.attendance_pct);
    if (exam.attendance_pct === null || exam.attendance_pct === undefined || !Number.isFinite(attendance)) attendance = null;
    var eligible = registered && attendance !== null && attendance >= 75;
    var reasons = [];
    if (!registered) reasons.push('Not registered');
    if (attendance === null || attendance < 75) reasons.push(attendance === null
      ? 'Attendance unavailable'
      : 'Below 75% (' + pct(attendance) + ')');
    return {
      eligible: eligible,
      label: eligible ? 'Eligible · ' + pct(attendance) : reasons.join(' · '),
      message: eligible ? '' : reasons.join(' and ') + (attendance === null ? '; 75% attendance is required.' : '.'),
    };
  }

  function renderAttendanceSummary(data) {
    clearView();
    var groups = [
      { label: 'Theory & tutorial', rows: data.courses.theory },
      { label: 'Lab', rows: data.courses.lab },
    ];
    var totalCourses = groups.reduce(function (sum, group) { return sum + group.rows.length; }, 0);
    if (!totalCourses) {
      view.appendChild(empty('No attendance records are available for the current session.'));
      return;
    }
    groups.forEach(function (group) {
      var card = node('section', null, 'card student-record-card');
      var header = node('div', null, 'hd');
      header.appendChild(node('h2', group.label));
      header.appendChild(node('span', group.rows.length + ' course' + (group.rows.length === 1 ? '' : 's'), 'muted'));
      card.appendChild(header);
      if (!group.rows.length) {
        card.appendChild(empty('No ' + group.label.toLowerCase() + ' attendance this session.'));
      } else {
        var rows = group.rows.map(function (course) {
          var detail = node('a', 'View dates');
          detail.href = '/student/attendance/detail?course_id=' + encodeURIComponent(course.course_id);
          return [
            node('span', course.course_code + ' · ' + course.course_name),
            courseType(course.course_type),
            course.total_sessions,
            course.attended,
            attendanceBar(course.attendance_pct),
            attendanceEligibility(course.attendance_pct),
            detail,
          ];
        });
        card.appendChild(table(['Course', 'Type', 'Total lectures / labs', 'Attended', 'Attendance', 'Eligibility', ''], rows));
      }
      view.appendChild(card);
    });
  }

  function renderAttendanceDetail() {
    requestJson('/student/api/attendance').then(function (summary) {
      var courses = summary.courses.theory.concat(summary.courses.lab);
      if (!courses.length) {
        clearView();
        view.appendChild(empty('No course attendance is available to show.'));
        return;
      }
      var params = new URLSearchParams(window.location.search);
      var selected = params.get('course_id');
      var card = node('section', null, 'card student-record-card');
      var label = node('label', 'Course', 'student-field');
      var select = node('select');
      select.setAttribute('aria-label', 'Select a course');
      courses.forEach(function (course) {
        var option = node('option', course.course_code + ' · ' + course.course_name);
        option.value = course.course_id;
        option.selected = String(course.course_id) === selected;
        select.appendChild(option);
      });
      label.appendChild(select);
      card.appendChild(label);
      var detail = node('div', null, 'student-detail');
      card.appendChild(detail);
      clearView();
      view.appendChild(card);

      var currentPage = 1;
      function load(page) {
        currentPage = page;
        detail.replaceChildren(node('div', 'Loading attendance dates…', 'student-state'));
        requestJson('/student/api/attendance/' + encodeURIComponent(select.value) + '?page=' + page)
          .then(function (data) {
            detail.replaceChildren();
            if (!data.records.length) detail.appendChild(empty('No conducted sessions are recorded for this course.'));
            else {
              var selectedCourse = courses.find(function (course) {
                return String(course.course_id) === select.value;
              });
              detail.appendChild(table(['Date', 'Lecture / lab', 'Attendance'], data.records.map(function (record) {
                var present = record.status === 'P';
                return [
                  date(record.session_date),
                  selectedCourse ? courseType(selectedCourse.course_type) : 'Class',
                  node('span', present ? 'Present' : 'Absent', present ? 'pill g' : 'pill r'),
                ];
              })));
            }
            var nav = node('div', null, 'pager');
            nav.appendChild(node('span', data.pagination.total + ' session' + (data.pagination.total === 1 ? '' : 's')));
            var controls = node('div', null, 'actions');
            var previous = node('button', 'Previous', 'btn small');
            previous.type = 'button';
            previous.disabled = data.pagination.page <= 1;
            previous.addEventListener('click', function () { load(currentPage - 1); });
            var next = node('button', 'Next', 'btn small');
            next.type = 'button';
            next.disabled = data.pagination.page >= data.pagination.pages;
            next.addEventListener('click', function () { load(currentPage + 1); });
            controls.append(previous, next);
            nav.appendChild(controls);
            detail.appendChild(nav);
          })
          .catch(showError);
      }
      select.addEventListener('change', function () { load(1); });
      load(1);
    }).catch(showError);
  }

  function renderExamSchedule(data) {
    clearView();
    if (!data.exams.length) {
      view.appendChild(empty('No exam cycle or scheduled exams are available right now.'));
      return;
    }
    view.appendChild(table(
      ['Course', 'Date', 'Session / time', 'Exam type', 'Attendance eligibility'],
      data.exams.map(function (exam) {
        var course = node('span', exam.course_code + ' · ' + exam.course_name);
        var eligibility = examEligibility(exam);
        return [
          course,
          date(exam.exam_date),
          (exam.session || '—') + ' · ' + time(exam.start_time) + ' – ' + time(exam.end_time),
          exam.exam_type + (exam.exam_mode ? ' · ' + exam.exam_mode : ''),
          node('span', eligibility.label, eligibility.eligible ? 'pill g' : 'pill r'),
        ];
      }),
    ));
  }

  function renderHallTickets(data) {
    var csrfInput = view.querySelector('[data-hall-ticket-csrf]');
    var csrfToken = csrfInput ? csrfInput.value : '';
    clearView();
    if (!data.exams.length) {
      view.appendChild(empty('No exam cycle or scheduled exams are available right now.'));
      return;
    }
    var cycles = [];
    data.exams.forEach(function (exam) {
      var group = cycles.find(function (cycle) { return cycle.exam_cycle_id === exam.exam_cycle_id; });
      if (!group) {
        group = { exam_cycle_id: exam.exam_cycle_id, exams: [] };
        cycles.push(group);
      }
      group.exams.push(exam);
    });

    cycles.forEach(function (cycle) {
      var first = cycle.exams[0];
      var eligibleExams = cycle.exams.filter(function (exam) { return examEligibility(exam).eligible; });
      var card = node('section', null, 'card student-record-card hall-ticket-cycle');
      var header = node('div', null, 'hd');
      var heading = node('div');
      heading.appendChild(node('h2', first.exam_type + ' · ' + first.academic_session_id));
      heading.appendChild(node('span', cycle.exams.length + ' scheduled exam' + (cycle.exams.length === 1 ? '' : 's'), 'muted'));
      header.appendChild(heading);

      var issued = cycle.exams.find(function (exam) { return exam.hall_ticket_status === 'Issued'; });
      var statusText = issued
        ? 'Issued · ' + (issued.hall_ticket_no || 'Ticket') + ' · ' + date(issued.hall_ticket_issued_on)
        : cycle.exams.some(function (exam) { return exam.hall_ticket_status === 'Pending Issue'; })
          ? 'Pending Issue'
          : '';
      if (statusText) header.appendChild(node('span', statusText, issued ? 'pill g' : 'pill o'));
      card.appendChild(header);

      if (eligibleExams.length && issued) {
        var viewLink = node('a', 'View / Print hall ticket', 'btn primary');
        viewLink.href = '/student/hall-ticket/' + encodeURIComponent(cycle.exam_cycle_id);
        var issuedActions = node('div', null, 'actions hall-ticket-cycle-actions');
        issuedActions.appendChild(viewLink);
        card.appendChild(issuedActions);
      } else if (eligibleExams.length) {
        var form = node('form', null, 'actions hall-ticket-cycle-actions');
        form.method = 'post';
        form.action = '/student/hall-ticket/' + encodeURIComponent(cycle.exam_cycle_id) + '/generate';
        var token = node('input');
        token.type = 'hidden';
        token.name = '_csrf';
        token.value = csrfToken;
        form.appendChild(token);
        var generate = node('button', 'Generate hall ticket', 'btn primary');
        generate.type = 'submit';
        form.appendChild(generate);
        card.appendChild(form);
      } else {
        card.appendChild(empty('No exams in this cycle are eligible for a hall ticket.'));
      }

      card.appendChild(table(
        ['Course', 'Date', 'Session / time', 'Attendance', 'Eligibility'],
        cycle.exams.map(function (exam) {
          var attendance = exam.attendance_pct === null || exam.attendance_pct === undefined
            ? 'No attendance recorded'
            : pct(exam.attendance_pct);
          var eligible = examEligibility(exam).eligible;
          var reasons = [];
          if (exam.registration_status !== 'Registered') reasons.push('Not registered');
          if (exam.attendance_pct === null || exam.attendance_pct === undefined) reasons.push('No attendance recorded');
          else if (Number(exam.attendance_pct) < 75) reasons.push('Attendance below 75%');
          var eligibilityCell = node('div', null, 'hall-ticket-eligibility');
          eligibilityCell.appendChild(node('span', eligible ? 'Eligible' : 'Not eligible', eligible ? 'pill g' : 'pill r'));
          if (!eligible) eligibilityCell.appendChild(node('span', reasons.join(' · '), 'hall-ticket-reason'));
          return [
            exam.course_code + ' · ' + exam.course_name,
            date(exam.exam_date),
            (exam.session || '—') + ' · ' + time(exam.start_time) + ' – ' + time(exam.end_time),
            attendance,
            eligibilityCell,
          ];
        }),
      ));
      view.appendChild(card);
    });
  }

  function resultsSection(title, headers, rows, emptyMessage) {
    var card = node('section', null, 'card student-record-card');
    card.appendChild(node('h2', title));
    if (!rows.length) card.appendChild(empty(emptyMessage));
    else card.appendChild(table(headers, rows));
    return card;
  }

  function renderResults(data) {
    clearView();
    var summary = node('section', null, 'cards student-result-kpis');
    var cgpaCard = node('div', null, 'card');
    cgpaCard.appendChild(node('div', 'Cumulative GPA', 'note'));
    cgpaCard.appendChild(node('div', data.cgpa ? Number(data.cgpa.cgpa).toFixed(2) : '—', 'kpi'));
    if (data.cgpa) {
      cgpaCard.appendChild(node('div', 'Across ' + data.cgpa.semesters_completed + ' completed semesters', 'sm'));
    } else {
      cgpaCard.appendChild(node('div', 'No cumulative result is available yet.', 'sm'));
    }
    summary.appendChild(cgpaCard);
    view.appendChild(summary);

    view.appendChild(resultsSection('Exam marks',
      ['Cycle', 'Course', 'Type', 'Internal', 'Mid-semester', 'End-semester / Practical', 'End-sem status'],
      data.marks.map(function (mark) {
        return [
          mark.exam_type,
          mark.course_code + ' · ' + mark.course_name,
          courseType(mark.course_type),
          componentMark(mark.internal_marks, mark.internal_max),
          componentMark(mark.midsem_marks, mark.midsem_max),
          componentMark(mark.endsem_marks, mark.endsem_max),
          mark.endsem_status,
        ];
      }), 'No exam marks are available yet.'));
    view.appendChild(resultsSection('Course results',
      ['Session · semester', 'Course', 'Type', 'Internal', 'Mid-semester', 'End-semester / Practical', 'Total', 'Percentage', 'Grade', 'Status'],
      data.course_results.map(function (result) {
        return [
          result.academic_session_id + ' · ' + result.semester,
          result.course_code + ' · ' + result.course_name,
          courseType(result.course_type),
          componentMark(result.internal_marks, result.internal_max),
          componentMark(result.midsem_marks, result.midsem_max),
          componentMark(result.endsem_marks, result.endsem_max),
          result.total_marks + ' / ' + result.max_marks,
          pct(result.percentage),
          result.grade + ' · ' + result.grade_points,
          result.result_status + (result.is_final_attempt ? '' : ' · Attempt ' + result.attempt_no),
        ];
      }), 'No course results are available yet.'));
    view.appendChild(resultsSection('Semester results',
      ['Session · semester', 'SGPA', 'Credits earned / registered', 'Backlogs', 'Status'],
      data.semester_results.map(function (result) {
        return [
          result.academic_session_id + ' · ' + result.semester,
          Number(result.sgpa).toFixed(2),
          result.credits_earned + ' / ' + result.credits_registered,
          result.backlogs,
          result.result_status,
        ];
      }), 'No semester results are available yet.'));
  }

  if (mode === 'attendance-summary') {
    requestJson('/student/api/attendance').then(renderAttendanceSummary).catch(showError);
  } else if (mode === 'attendance-detail') {
    renderAttendanceDetail();
  } else if (mode === 'exam-schedule' || mode === 'hall-ticket') {
    requestJson('/student/api/exams').then(mode === 'exam-schedule' ? renderExamSchedule : renderHallTickets).catch(showError);
  } else if (mode === 'results') {
    requestJson('/student/api/results').then(renderResults).catch(showError);
  }
})();
