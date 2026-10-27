// Raise-a-grievance form (views/shared/grievance-new.ejs): show the course fields only for a
// course grievance, and pick the teacher automatically from the chosen course (theory first).
(function () {
  'use strict';
  var form = document.getElementById('grievance-form');
  var course = document.getElementById('gcourse');
  var teacher = document.getElementById('gteacher');
  if (!form || !course || !teacher) return;

  function about() {
    var checked = form.querySelector('input[name="about"]:checked');
    return checked ? checked.value : 'general';
  }

  function syncAbout() {
    var isCourse = about() === 'course';
    form.querySelectorAll('[data-about="course"]').forEach(function (el) { el.hidden = !isCourse; });
    course.required = isCourse;
  }

  // keep only this course's teachers; the server lists them lectures first, so the first is the default
  function syncTeachers() {
    var first = null;
    Array.prototype.forEach.call(teacher.options, function (opt) {
      if (!opt.value) { opt.hidden = true; return; }
      var match = opt.dataset.course === course.value;
      opt.hidden = !match;
      opt.disabled = !match;
      if (match && !first) first = opt;
    });
    teacher.value = first ? first.value : '';
    teacher.disabled = !first;
  }

  form.querySelectorAll('input[name="about"]').forEach(function (r) { r.addEventListener('change', syncAbout); });
  course.addEventListener('change', syncTeachers);
  syncAbout();
  syncTeachers();
})();
