(function () {
  'use strict';

  var root = document.querySelector('[data-faculty-examination]');
  if (!root) return;

  var csrf = document.querySelector('input[name="_csrf"]');
  var csrfToken = csrf ? csrf.value : '';
  var courses = [];
  var current = null;

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
    courseField.appendChild(el('label', 'Course'));
    var courseSelect = el('select');
    courseSelect.setAttribute('aria-label', 'Choose an assigned course');
    courseField.appendChild(courseSelect);

    var cycleField = el('div', null, 'field');
    cycleField.appendChild(el('label', 'Examination cycle'));
    var cycleSelect = el('select');
    cycleSelect.setAttribute('aria-label', 'Choose an examination cycle');
    cycleField.appendChild(cycleSelect);
    selectors.append(courseField, cycleField);
    form.appendChild(selectors);

    var scheme = el('div', null, 'faculty-exam-scheme muted');
    var summary = el('div', null, 'faculty-exam-summary');
    var tablePanel = el('div', null, 'faculty-exam-table');
    var toolbar = el('div', null, 'faculty-exam-toolbar');
    var save = el('button', 'Save marks', 'btn primary');
    save.type = 'button';
    save.disabled = true;
    var notice = el('div');
    notice.setAttribute('role', 'status');
    toolbar.append(save, notice);
    root.append(form, scheme, summary, tablePanel, toolbar);

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
      tablePanel.replaceChildren(el('div', 'Loading course roster…', 'student-state'));
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
        var maxima = result.course;
        scheme.textContent = maxima.total_max === null
          ? 'This course does not have a configured examination scheme.'
          : (maxima.course_type === 'LAB' ? 'Lab' : maxima.course_type === 'TH' ? 'Theory' : 'Tutorial')
            + ' — ' + componentFields(maxima).map(function (field) {
              return field.label + ': ' + field.max;
            }).join(', ') + ' (Total: ' + maxima.total_max
            + '; pass: ' + maxima.passing_percentage + '%).';
        renderSummary();
        renderTable();
      }).catch(function (error) { showError(tablePanel, error); });
    }

    function renderSummary() {
      summary.replaceChildren();
      if (!current) return;
      var data = current.summary;
      var average = data.average_total === null ? '—'
        : Number(data.average_total).toFixed(1) + ' / ' + current.course.total_max;
      [
        ['Students', data.roster_size],
        ['Marks entered', data.marks_entered + ' / ' + data.roster_size],
        ['Pending', Math.max(0, data.roster_size - data.marks_entered)],
        ['Class average', average],
      ].forEach(function (item) {
        var card = el('div', null, 'faculty-exam-stat');
        card.append(el('span', item[0], 'muted'), el('strong', item[1]));
        summary.appendChild(card);
      });
    }

    function renderTable() {
      tablePanel.replaceChildren();
      if (!current.selected_cycle) {
        tablePanel.appendChild(el('div', 'There is no open examination cycle for the current academic session.', 'empty'));
        save.disabled = true;
        return;
      }
      if (current.course.total_max === null) {
        tablePanel.appendChild(el('div', 'Marks cannot be entered until the course examination scheme is configured.', 'empty'));
        save.disabled = true;
        return;
      }
      if (!current.students.length) {
        tablePanel.appendChild(el('div', 'No students are enrolled in this assigned course.', 'empty'));
        save.disabled = true;
        return;
      }

      var table = el('table');
      var head = el('thead');
      var header = el('tr');
      var fields = componentFields(current.course);
      ['Roll', 'Student number', 'Student'].concat(fields.map(function (field) {
        return field.label + ' (/' + field.max + ')';
      }), ['Total (/' + current.course.total_max + ')']).forEach(function (label) {
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
          input.max = field.max;
          input.step = '0.1';
          input.value = student[field.key] === null ? '' : student[field.key];
          input.dataset.component = field.key;
          input.dataset.max = field.max;
          input.setAttribute('aria-label', field.label + ' marks for ' + student.name);
          var error = el('span', '', 'field-error');
          error.dataset.errorFor = field.key;
          error.setAttribute('aria-live', 'polite');
          cell.append(input, error);
          row.appendChild(cell);
          input.addEventListener('input', function () { updateRow(row, fields, current.course.total_max); });
        });
        var total = el('td', '', 'faculty-exam-total');
        total.dataset.total = 'true';
        row.appendChild(total);
        updateRow(row, fields, current.course.total_max);
        body.appendChild(row);
      });
      table.append(head, body);
      var wrapper = el('div', null, 'sc');
      wrapper.appendChild(table);
      tablePanel.appendChild(wrapper);
      save.disabled = false;
    }

    function componentFields(course) {
      var endsemLabel = course.course_type === 'LAB' ? 'Practical' : 'Endsem';
      return [
        { key: 'internal_marks', label: 'Internal', max: course.internal_max },
        { key: 'midsem_marks', label: 'Midsem', max: course.midsem_max },
        { key: 'endsem_marks', label: endsemLabel, max: course.endsem_max },
      ].filter(function (field) { return Number(field.max) > 0; });
    }

    function updateRow(row, fields, totalMax) {
      var valid = true;
      var total = 0;
      fields.forEach(function (field) {
        var input = row.querySelector('input[data-component="' + field.key + '"]');
        var error = row.querySelector('[data-error-for="' + field.key + '"]');
        var value = input.value === '' ? null : Number(input.value);
        var invalid = value !== null && (!Number.isFinite(value) || value < 0
          || value > Number(field.max) || Math.abs(value * 10 - Math.round(value * 10)) > 1e-8);
        input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        error.textContent = invalid ? 'Enter 0–' + field.max + ' (max 1 decimal place).' : '';
        if (invalid) valid = false;
        else if (value !== null) total += value;
      });
      var totalCell = row.querySelector('[data-total]');
      var roundedTotal = Math.round(total);
      totalCell.textContent = valid ? roundedTotal + ' / ' + totalMax : 'Invalid';
      totalCell.setAttribute('aria-label', valid ? 'Total ' + roundedTotal + ' out of ' + totalMax : 'Invalid marks');
      row.dataset.valid = valid ? 'true' : 'false';
      return valid;
    }

    function selectedCycleId() {
      return cycleSelect.value || '';
    }

    courseSelect.addEventListener('change', function () { loadCourse(); });
    cycleSelect.addEventListener('change', function () { loadCourse(selectedCycleId()); });
    save.addEventListener('click', function () {
      if (!current || !current.selected_cycle) return;
      var entries = [];
      var invalidRows = [];
      Array.prototype.forEach.call(tablePanel.querySelectorAll('tbody tr'), function (row) {
        if (!updateRow(row, componentFields(current.course), current.course.total_max)) {
          invalidRows.push(row);
          return;
        }
        var inputs = row.querySelectorAll('input[data-component]');
        var entry = {
          student_id: Number(row.dataset.studentId),
          internal_marks: null,
          midsem_marks: null,
          endsem_marks: null,
        };
        Array.prototype.forEach.call(inputs, function (input) {
          entry[input.dataset.component] = input.value === '' ? null : Number(input.value);
        });
        if (invalidRows.length) {
          notice.textContent = 'Correct the highlighted marks before saving.';
          invalidRows[0].querySelector('input[aria-invalid="true"]').focus();
          return;
        }
        if (row.dataset.existing === 'true' || Object.keys(entry).some(function (key) {
          return key !== 'student_id' && entry[key] !== null;
        })) entries.push(entry);
      });
      if (!entries.length) {
        notice.textContent = 'Enter at least one score before saving.';
        return;
      }
      save.disabled = true;
      notice.textContent = 'Saving marks and updating course results…';
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
