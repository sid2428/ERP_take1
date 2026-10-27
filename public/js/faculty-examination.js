(function () {
  'use strict';

  var root = document.querySelector('[data-faculty-examination]');
  if (!root) return;

  var csrf = document.querySelector('input[name="_csrf"]');
  var csrfToken = csrf ? csrf.value : '';
  var courses = [];
  var current = null;
  var currentFilter = 'all';

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
    target.replaceChildren(el('div', error && error.message ? error.message : 'Could not load examination marks.', 'flash error'));
  }

  function getGradeInfo(pct) {
    if (pct >= 80) return { grade: 'O', label: 'Outstanding (≥80%)', cls: 'g' };
    if (pct >= 70) return { grade: 'A+', label: 'Excellent (≥70%)', cls: 'g' };
    if (pct >= 60) return { grade: 'A', label: 'Very Good (≥60%)', cls: 'g' };
    if (pct >= 55) return { grade: 'B+', label: 'Good (≥55%)', cls: '' };
    if (pct >= 50) return { grade: 'B', label: 'Above Avg (≥50%)', cls: '' };
    if (pct >= 45) return { grade: 'C', label: 'Average (≥45%)', cls: 'o' };
    if (pct >= 40) return { grade: 'P', label: 'Pass (≥40%)', cls: 'o' };
    return { grade: 'F', label: 'Needs Attention (<40%)', cls: 'r' };
  }

  function formatMark(value) {
    return String(Math.round(value * 10) / 10);
  }

  function hasMarks(student, fields) {
    return fields.some(function (field) {
      return student[field.key] !== null && student[field.key] !== undefined;
    });
  }

  function setup(data) {
    courses = data.courses;
    root.replaceChildren();
    if (!courses.length) {
      root.appendChild(el('div', 'No assigned courses were found for the current academic session.', 'empty'));
      return;
    }

    var form = el('div', null, 'faculty-exam-form');
    var selectors = el('div', null, 'form-grid');
    var courseField = el('div', null, 'field');
    courseField.appendChild(el('label', 'Assigned Course'));
    var courseSelect = el('select');
    courseSelect.setAttribute('aria-label', 'Choose your assigned course');
    courseField.appendChild(courseSelect);

    var cycleField = el('div', null, 'field');
    cycleField.appendChild(el('label', 'Examination Cycle'));
    var cycleSelect = el('select');
    cycleSelect.setAttribute('aria-label', 'Choose examination cycle');
    cycleField.appendChild(cycleSelect);
    selectors.append(courseField, cycleField);
    form.appendChild(selectors);

    var scheme = el('div', null, 'faculty-exam-scheme muted');
    var summary = el('div', null, 'faculty-exam-summary');
    summary.style.marginTop = '12px';

    var filterToolbar = el('div', null, 'faculty-exam-toolbar');
    filterToolbar.style.marginTop = '14px';
    filterToolbar.style.justifyContent = 'space-between';

    var filterGroup = el('div', null, 'filter-pills');
    filterGroup.style.display = 'flex';
    filterGroup.style.gap = '8px';

    var actionGroup = el('div', null, 'action-buttons');
    actionGroup.style.display = 'flex';
    actionGroup.style.gap = '8px';

    var exportBtn = el('button', '📥 Export Marks Sheet (CSV)', 'btn small');
    exportBtn.type = 'button';
    actionGroup.appendChild(exportBtn);

    filterToolbar.append(filterGroup, actionGroup);

    var tablePanel = el('div', null, 'faculty-exam-table');
    tablePanel.style.marginTop = '10px';

    var toolbar = el('div', null, 'faculty-exam-toolbar');
    toolbar.style.marginTop = '16px';
    var save = el('button', 'Save marks', 'btn primary');
    save.type = 'button';
    save.disabled = true;
    var notice = el('div');
    notice.setAttribute('role', 'status');
    toolbar.append(save, notice);
    root.append(form, scheme, summary, filterToolbar, tablePanel, toolbar);

    courses.forEach(function (course) {
      var suffix = course.marks_entered
        ? ' · ' + course.marks_entered + '/' + course.roster_size + ' entered'
        : ' · 0/' + course.roster_size + ' entered';
      var option = el('option', course.course_code + ' · ' + course.course_name + suffix);
      option.value = course.course_id;
      courseSelect.appendChild(option);
    });

    function loadCourse(cycleId) {
      var courseId = courseSelect.value;
      if (!courseId) return;
      tablePanel.replaceChildren(el('div', 'Loading class roster…', 'student-state'));
      save.disabled = true;
      var url = '/faculty/examination/courses/' + encodeURIComponent(courseId);
      if (cycleId) url += '?exam_cycle_id=' + encodeURIComponent(cycleId);
      fetchJson(url).then(function (result) {
        current = result;
        cycleSelect.replaceChildren();
        result.cycles.forEach(function (cycle) {
          var option = el('option', cycle.exam_type + ' · ' + cycle.start_date + ' – ' + cycle.end_date);
          option.value = cycle.exam_cycle_id;
          if (result.selected_cycle && cycle.exam_cycle_id === result.selected_cycle.exam_cycle_id) option.selected = true;
          cycleSelect.appendChild(option);
        });
        cycleSelect.disabled = result.cycles.length === 0;

        var fields = componentFields(result.course);
        scheme.textContent = fields.length
          ? 'Assessment scheme: ' + fields.map(function (field) {
            return field.label + ' / ' + field.max;
          }).join(' · ')
          : 'No examination scheme is configured for this course.';

        renderSummary();
        renderFilterButtons();
        renderTable();
      }).catch(function (error) { showError(tablePanel, error); });
    }

    function renderSummary() {
      summary.replaceChildren();
      if (!current) return;
      var data = current.summary;

      var fields = componentFields(current.course);
      var totalMax = Number(current.course.total_max);
      var enteredCount = 0;
      var passCount = 0;
      var totalSum = 0;
      var highestMark = null;

      current.students.forEach(function (s) {
        if (!hasMarks(s, fields)) return;
        enteredCount += 1;
        var val = fields.reduce(function (sum, field) {
          return sum + Number(s[field.key] || 0);
        }, 0);
        totalSum += val;
        if (highestMark === null || val > highestMark) highestMark = val;
        if (totalMax > 0 && (val / totalMax) * 100 >= 40) passCount += 1;
      });

      var avgText = enteredCount > 0
        ? formatMark(totalSum / enteredCount) + ' / ' + totalMax
        : '—';
      var passRateText = enteredCount > 0 ? Math.round((passCount / enteredCount) * 100) + '%' : '—';

      [
        ['Class Students', data.roster_size],
        ['Marks Entered', enteredCount + ' / ' + data.roster_size],
        ['Pending Entry', Math.max(0, data.roster_size - enteredCount)],
        ['Class Average', avgText],
        ['Pass Rate (≥40%)', passRateText],
        ['Highest Mark', highestMark !== null ? formatMark(highestMark) + ' / ' + totalMax : '—'],
      ].forEach(function (item) {
        var card = el('div', null, 'faculty-exam-stat');
        card.append(el('span', item[0], 'muted'), el('strong', item[1]));
        summary.appendChild(card);
      });
    }

    function renderFilterButtons() {
      filterGroup.replaceChildren();
      if (!current) return;
      var total = current.students.length;
      var fields = componentFields(current.course);
      var pending = current.students.filter(function (s) {
        return !hasMarks(s, fields);
      }).length;

      var filters = [
        { key: 'all', label: 'All Students (' + total + ')' },
        { key: 'pending', label: 'Pending (' + pending + ')' },
        { key: 'passed', label: 'Passing (≥40%)' },
        { key: 'failed', label: 'Needs Attention (<40%)' },
      ];

      filters.forEach(function (f) {
        var btn = el('button', f.label, 'btn small' + (currentFilter === f.key ? ' primary' : ''));
        btn.type = 'button';
        btn.addEventListener('click', function () {
          currentFilter = f.key;
          renderFilterButtons();
          applyRowFilters();
        });
        filterGroup.appendChild(btn);
      });
    }

    function applyRowFilters() {
      var rows = tablePanel.querySelectorAll('tbody tr');
      rows.forEach(function (row) {
        var hasEntered = row.dataset.hasMarks === 'true';
        var pct = Number(row.dataset.pct || 0);

        if (currentFilter === 'all') {
          row.style.display = '';
        } else if (currentFilter === 'pending') {
          row.style.display = hasEntered ? 'none' : '';
        } else if (currentFilter === 'passed') {
          row.style.display = hasEntered && pct >= 40 ? '' : 'none';
        } else if (currentFilter === 'failed') {
          row.style.display = hasEntered && pct < 40 ? '' : 'none';
        }
      });
    }

    function renderTable() {
      tablePanel.replaceChildren();
      if (!current.selected_cycle) {
        tablePanel.appendChild(el('div', 'There is no open examination cycle for the current academic session.', 'empty'));
        save.disabled = true;
        return;
      }
      if (!current.students.length) {
        tablePanel.appendChild(el('div', 'No students are enrolled in this assigned course.', 'empty'));
        save.disabled = true;
        return;
      }

      var fields = componentFields(current.course);
      var totalMax = Number(current.course.total_max);
      if (!fields.length || !Number.isFinite(totalMax) || totalMax <= 0) {
        tablePanel.appendChild(el('div', 'No examination scheme is configured for this course.', 'empty'));
        save.disabled = true;
        return;
      }

      var table = el('table');
      var head = el('thead');
      var header = el('tr');
      ['Roll', 'Student Number', 'Student Name'].concat(fields.map(function (field) {
        return field.label + ' (/' + field.max + ')';
      }), ['Total (/' + totalMax + ')', 'Performance / Grade']).forEach(function (label) {
        header.appendChild(el('th', label));
      });
      head.appendChild(header);

      var body = el('tbody');
      current.students.forEach(function (student) {
        var row = el('tr');
        row.dataset.studentId = student.student_id;
        row.dataset.existing = student.attempt_no === null ? 'false' : 'true';
        row.appendChild(el('td', student.roll_no === null ? '—' : student.roll_no));
        row.appendChild(el('td', student.student_number, 'code'));
        row.appendChild(el('td', student.name));

        fields.forEach(function (field) {
          var cell = el('td');
          var input = el('input');
          input.type = 'number';
          input.min = '0';
          input.max = String(field.max);
          input.step = '0.1';
          input.value = student[field.key] === null || student[field.key] === undefined
            ? ''
            : student[field.key];
          input.dataset.component = field.key;
          input.dataset.max = String(field.max);
          input.setAttribute('aria-label', field.label + ' marks for ' + student.name);
          var error = el('span', '', 'field-error');
          error.dataset.errorFor = field.key;
          error.id = 'mark-error-' + student.student_id + '-' + field.key;
          error.setAttribute('aria-live', 'polite');
          input.setAttribute('aria-describedby', error.id);
          input.setAttribute('aria-invalid', 'false');
          cell.append(input, error);
          row.appendChild(cell);

          input.addEventListener('input', function () {
            if (updateRow(row, fields, totalMax)) {
              fields.forEach(function (item) {
                var currentInput = row.querySelector('input[data-component="' + item.key + '"]');
                student[item.key] = currentInput.value === '' ? null : Number(currentInput.value);
              });
            }
            renderSummary();
            renderFilterButtons();
            applyRowFilters();
          });
        });

        var total = el('td', '', 'faculty-exam-total');
        total.dataset.total = 'true';
        row.appendChild(total);

        var gradeCell = el('td', '', 'faculty-exam-grade');
        gradeCell.dataset.gradeCell = 'true';
        row.appendChild(gradeCell);

        updateRow(row, fields, totalMax);
        body.appendChild(row);
      });

      table.append(head, body);
      var wrapper = el('div', null, 'sc');
      wrapper.appendChild(table);
      tablePanel.appendChild(wrapper);
      save.disabled = false;
      applyRowFilters();
    }

    function componentFields(course) {
      return [
        { key: 'internal_marks', label: 'Internal', max: course.internal_max },
        { key: 'midsem_marks', label: 'Midsem', max: course.midsem_max },
        {
          key: 'endsem_marks',
          label: course.course_type === 'LAB' ? 'Practical' : 'EndSem',
          max: course.endsem_max,
        },
      ].filter(function (field) {
        return Number.isFinite(Number(field.max)) && Number(field.max) > 0;
      }).map(function (field) {
        return { key: field.key, label: field.label, max: Number(field.max) };
      });
    }

    function updateRow(row, fields, totalMax) {
      var valid = true;
      var total = 0;
      var anyEntered = false;

      fields.forEach(function (field) {
        var input = row.querySelector('input[data-component="' + field.key + '"]');
        var error = row.querySelector('[data-error-for="' + field.key + '"]');
        var empty = input.value === '' && !input.validity.badInput;
        var value = empty ? null : Number(input.value);
        var invalid = input.validity.badInput || (value !== null && (!Number.isFinite(value) || value < 0
          || value > field.max || Math.abs(value * 10 - Math.round(value * 10)) > 1e-8));

        input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        error.textContent = invalid
          ? 'Enter 0–' + field.max + ' (max 1 decimal place).'
          : '';

        if (invalid) {
          valid = false;
        } else if (value !== null) {
          total += value;
          anyEntered = true;
        }
      });

      var totalCell = row.querySelector('[data-total]');
      var gradeCell = row.querySelector('[data-grade-cell]');
      var roundedTotal = Math.round(total * 10) / 10;
      var pct = totalMax > 0 ? (total / totalMax) * 100 : 0;

      row.dataset.hasMarks = valid && anyEntered ? 'true' : 'false';
      row.dataset.pct = valid ? pct : 0;

      totalCell.textContent = valid ? (anyEntered ? formatMark(roundedTotal) + ' / ' + totalMax : '—') : 'Invalid';
      totalCell.setAttribute('aria-label', valid ? 'Total ' + roundedTotal + ' out of ' + totalMax : 'Invalid marks');

      if (gradeCell) {
        if (!valid) {
          gradeCell.replaceChildren(el('span', 'Invalid score', 'pill r'));
        } else if (anyEntered) {
          var info = getGradeInfo(pct);
          var pill = el('span', info.grade + ' (' + formatMark(roundedTotal) + '/' + totalMax + ')', 'pill' + (info.cls ? ' ' + info.cls : ''));
          pill.title = info.label;
          gradeCell.replaceChildren(pill);
        } else {
          gradeCell.replaceChildren(el('span', '—', 'muted'));
        }
      }

      row.dataset.valid = valid ? 'true' : 'false';
      return valid;
    }

    function selectedCycleId() {
      return cycleSelect.value || '';
    }

    // CSV Export functionality
    exportBtn.addEventListener('click', function () {
      if (!current || !current.students.length) return;
      var fields = componentFields(current.course);
      var totalMax = Number(current.course.total_max);
      var csvRows = [[
        'Roll No',
        'Student Number',
        'Student Name',
      ].concat(fields.map(function (field) {
        return field.label + ' (/' + field.max + ')';
      }), ['Total (/' + totalMax + ')', 'Percentage', 'Grade Status'])];

      var rows = tablePanel.querySelectorAll('tbody tr');
      rows.forEach(function (row, idx) {
        var s = current.students[idx];
        if (!s) return;
        var pct = Number(row.dataset.pct || 0);
        var total = row.querySelector('[data-total]').textContent;
        csvRows.push([
          s.roll_no || '',
          s.student_number,
          '"' + s.name.replace(/"/g, '""') + '"',
        ].concat(fields.map(function (field) {
          var input = row.querySelector('input[data-component="' + field.key + '"]');
          return input ? input.value : '';
        }), [
          total === '—' ? '' : total,
          row.dataset.hasMarks === 'true' ? Math.round(pct) + '%' : '',
          row.dataset.hasMarks === 'true' ? getGradeInfo(pct).grade : '',
        ]));
      });

      var csvContent = 'data:text/csv;charset=utf-8,' + csvRows.map(function (e) { return e.join(','); }).join('\n');
      var encodedUri = encodeURI(csvContent);
      var link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', (current.course.course_code || 'Course') + '_Marks_Sheet.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });

    courseSelect.addEventListener('change', function () { loadCourse(); });
    cycleSelect.addEventListener('change', function () { loadCourse(selectedCycleId()); });

    save.addEventListener('click', function () {
      if (!current || !current.selected_cycle) return;
      var fields = componentFields(current.course);
      var totalMax = Number(current.course.total_max);
      var entries = [];
      var invalidRows = [];

      Array.prototype.forEach.call(tablePanel.querySelectorAll('tbody tr'), function (row) {
        if (!updateRow(row, fields, totalMax)) {
          invalidRows.push(row);
        }
        var entry = {
          student_id: Number(row.dataset.studentId),
          internal_marks: null,
          midsem_marks: null,
          endsem_marks: null,
        };
        var anyEntered = false;
        fields.forEach(function (field) {
          var input = row.querySelector('input[data-component="' + field.key + '"]');
          entry[field.key] = input.value === '' ? null : Number(input.value);
          if (entry[field.key] !== null) anyEntered = true;
        });
        if (row.dataset.existing === 'true' || anyEntered) entries.push(entry);
      });

      if (invalidRows.length) {
        notice.textContent = 'Correct the highlighted marks before saving.';
        invalidRows[0].querySelector('input[aria-invalid="true"]').focus();
        return;
      }

      if (!entries.length) {
        notice.textContent = 'Enter at least one mark before saving.';
        return;
      }

      save.disabled = true;
      notice.textContent = 'Saving marks and updating course records…';
      var body = new URLSearchParams({
        _csrf: csrfToken,
        exam_cycle_id: String(current.selected_cycle.exam_cycle_id),
        entries_json: JSON.stringify(entries),
      });

      fetchJson('/faculty/examination/courses/' + encodeURIComponent(current.course.course_id) + '/marks', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrfToken },
        body: body.toString(),
      }).then(function (result) {
        notice.textContent = result.message + ' Updated ' + result.course_results_updated + ' student results.';
        var selected = selectedCycleId();
        loadCourse(selected);
      }).catch(function (error) {
        save.disabled = false;
        notice.textContent = '';
        showError(notice, error);
      });
    });

    loadCourse();
  }

  fetchJson('/faculty/examination/courses')
    .then(setup)
    .catch(function (error) { showError(root, error); });
}());
